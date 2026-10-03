#!/usr/bin/env node
// E-PT8: the PT-8-lite cutover orchestrator (design/pt8-lite-design-2026-10-02.md).
//
// It drives one PT-2-lite seal (cutover-source-seal.mjs, read only through
// its public readCutoverSeal / openSealedSourceFromSeal exports, so a change
// to the seal's ingestion layout slots in behind them) into the one
// registered PostgreSQL 17 target through PT-1's production handle
// (postgres-transfer-target.mjs), and then finalizes that target to live.
//
// Subcommands (every one takes --owner-dir <0700 dir>; the owner directory
// holds pt8-inputs.json, written by the owner, and every receipt below):
//
//   identity-pin      OWNER ONLY. Reads IDENTITY_LINK_SECRET from stdin and
//                     writes identity-pin.json (0400). No database.
//   identity-rotate-pin
//                     OWNER ONLY (round 16: the production secret is lost).
//                     Reads the NEW IDENTITY_LINK_SECRET from stdin and the
//                     sealed D1 pin from --sealed-pin-file (a private file);
//                     writes identity-pin.json (the new label) and
//                     identity-rotation.json (0400, once each). No database.
//                     --from-key-version must be a retired production label
//                     and --to-key-version the label the origin runs
//                     (cloud-run/postgres-production-configuration.mjs).
//                     The inputs then declare identityLinkRotation, and the
//                     run needs a second token (--confirm-identity-rotation).
//   target-check      Read-only, before the fence: contract, PostgreSQL 17,
//                     migration tail, empty target, transfer-login memberships,
//                     trigger-policy coverage, the frozen-read table.
//   preflight         Read-only: P1-P16 (seal, fence binding, coverage,
//                     correction runtime, erasure quiescence, the deletion-
//                     digest exclusion count, bootstrap, identity pin bound
//                     to the sealed row and to the committed production
//                     desired state's mount, controls, target, scheduler
//                     pause, the OWN-4 export, the pending-object guard,
//                     Sparkle nonces, the analytics D1 admin history export
//                     bound to this seal, the REV-SEED revision floor bound
//                     to this seal and at or above every frozen-read
//                     revision, captured inside this fence unless the
//                     inputs declare the dress rehearsal's synthetic floor).
//                     GO writes preflight.json (0400);
//                     NO-GO writes nothing.
//   run               PROTECTED. Re-proves P10's memberships and P11's
//                     scheduler pause, then R1 open/begin, R2 every stage of
//                     the plan (runners, PT-8's own stages, waivers), R3
//                     post-import, R4 'verifying' then 'verified'.
//   release-controls  PROTECTED. Validates flip-1 evidence (PT-2
//                     verify-unchanged, taken after 'verified'), then
//                     restoreSealedCollectionControls, then reads the
//                     database clock once (the release instant). Writes
//                     release-controls.json (0400).
//   flip-gate         Read-only: flip-2 evidence taken after the recorded
//                     release instant,
//                     the staging-drop readback, the frozen read equal to
//                     the export post-import loaded (post-import.json),
//                     assertFlipReady, zero unexpired sealed Sparkle nonces.
//                     Writes flip-gate.json (0400).
//   mark-live         PROTECTED, the point of no return for the target.
//                     markLive with the flip-2 sha256. Writes mark-live.json.
//   post-live-check   Read-only: the first maintenance pass completed on one
//                     cycle less than 2 h ago. Writes post-live-check.json
//                     (0400, clock-free so a rerun is equal).
//   report            Requires post-live-check.json; writes pt8-report.json
//                     (0400): every receipt sha256 and every gate result.
//   abandon           PROTECTED, pre-live only: PT-1 abandonRun.
//
// Dry run by default: a PROTECTED step without --execute performs only its
// read-only checks and prints the exact authorization token it requires. With
// --execute it runs only when --confirm equals that token, which binds the
// step name, the seal, the contract, the inputs file and the step's own
// evidence (the preflight, the flip evidence, the flip gate), so a token can
// authorize exactly one step of exactly one cutover.
//
// The PT-1 finalize ORDER (design section 1, corrections 1 and 2):
//   R3 post-import: TL-1, admin history and exclusions, invariants, coverage
//     finalize, the parity sample, the C-IPR frozen read LOADED, then the
//     cursor scrub and the STAGING DROP (PT-1 admits both only while the run
//     is 'importing' or 'verifying', and 'verified' requires them done);
//   R4 'verifying' -> 'verified';
//   F1 flip-1 evidence (verify-unchanged) -> F2 restoreSealedCollectionControls
//   -> F3 flip-2 evidence -> F4 the staging-drop readback and assertFlipReady
//   -> F5 markLive.
// So the checklist's "verified, flip evidence, restore, staging drop,
// assertFlipReady, markLive" holds with the drop's PROOF read back at F4 and
// the drop itself (a recorded no-op while every tool's staging registry is
// empty) inside R3, and the frozen read is loaded before markLive.
//
// Resumable and idempotent: the database is authoritative. A rerun reopens
// the same seal's run, skips complete stages, re-converges every post-import
// sub-step to equal receipts, and replays finished transitions as no-ops.
// pt8-journal.ndjson (0600) is advisory only.
//
// Content-free: errors carry a closed code and at most a step, stage, table,
// check or class name; receipts hold names, counts, states and sha256 digests.
// No row value, id, secret or URL is ever printed or written.

import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CUTOVER_SOURCE_ROLES,
  CutoverSourceError,
  assertOwnerDirectory,
  canonicalJson,
  openSealedSourceFromSeal,
  readCutoverSeal,
  readPrivateFile,
  sha256Hex,
  writePrivateFileOnce,
} from "./cutover-source-seal.mjs";
import { CUTOVER_FLIP_EVIDENCE_SCHEMA } from "./cutover-source-fence.mjs";
import {
  countSealedParticipantDeletionMatches,
  participantDeletionDigest,
  readDeletionDigestProjection,
  readSealedDeletionDigests,
} from "./cutover-source-projections.mjs";
import { CORRECTION_RUNTIME_STAGED_STATE } from "./cutover-quiescence-check.mjs";
import {
  checkInterimPublicRead,
  loadInterimPublicReadInTransaction,
  readInterimExportFile,
} from "./gcp-interim-public-read-load.mjs";
import {
  REVISION_FLOOR_TABLES,
  assertRevisionFloorBinding,
  assertRevisionFloorCoversFrozen,
  checkRevisionFloorProvenance,
  loadRevisionFloorInTransaction,
  readRevisionFloorFile,
  revisionFloorSealFacts,
  revisionFloorSummary,
} from "./cutover-revision-floor.mjs";
import {
  PARTICIPANT_NOT_QUIESCENT_PREDICATE,
  PUBLIC_SOURCE_BOOTSTRAP_POLICY,
  runIdentityAuthorityTransfer,
} from "./postgres-identity-authority-transfer.mjs";
import {
  IDENTITY_LINK_PIN_SCHEMA,
  IDENTITY_LINK_ROTATION_SCHEMA,
  assertPinMatchesMount,
  assertPinMatchesSealed,
  assertRotationLabels,
  assertRotationMatchesSealed,
  buildIdentityLinkPin,
  buildIdentityLinkRotation,
  parseSealedPinFile,
  readSecretFromStream,
  validateIdentityLinkPin,
  validateIdentityLinkRotation,
} from "./postgres-identity-link-pin.mjs";
import {
  IDENTITY_LINK_CONSUMER_ROUTE_IDS,
  PRODUCTION_ROUTE_CLASSES,
  PRODUCTION_ROUTE_TABLE,
  assertIdentityLinkConsumersRetired,
} from "../cloud-run/postgres-production-registry.mjs";
import {
  PRODUCTION_IDENTITY_LINK_SECRET_VERSION,
  PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS,
} from "../cloud-run/postgres-production-configuration.mjs";
import {
  OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING,
  checkAdminHistoryExportBinding,
  checkPendingObjectTransferGuard,
  runLegacyContributionsProduction,
  runOperationalHistoryProduction,
  runPendingRegistrationsProduction,
} from "./postgres-legacy-contribution-transfer.mjs";
import { genericSealedDigest } from "./postgres-production-telemetry-engine.mjs";
import { TELEMETRY_PRODUCTION_RUNNERS } from "./postgres-production-telemetry-modes.mjs";
import {
  COMPLETE_TRIGGER_POLICY,
  DISPOSITIONS,
  DISPOSITION_INDEX,
  OWNER_FLAG_DRESS_REHEARSAL_SYNTHETIC_REVISION_FLOOR,
  RUNTIME_RESET_TABLES,
  STAGE_PLAN,
  STAGING_DROP_REGISTRY,
  STAGING_SCRUB_REGISTRY,
  TransferCoverageError,
  assertWaiverAllowed,
  dispositionPolicySha256,
  evaluateSealedCoverage,
  sealedCatalog,
  stagePrerequisites,
  stageWaiverSha256,
  validateOwnerFlags,
} from "./postgres-transfer-coverage.mjs";
import { ParitySampleError, runParitySample } from "./postgres-transfer-parity-sample.mjs";
import {
  PostgresTransferTargetError,
  SEEDED_SINGLETONS,
  TRANSFER_CONTROL_SCHEMA,
  abandonRun,
  advanceRun,
  assertCollectionControlsDegradedForImport,
  assertControlSchemaAllowlist,
  assertFlipReady,
  assertNoRuntimePrivilege,
  assertNoTransferUserOwnership,
  assertTriggerPolicyCoverage,
  beginRun,
  dropTransferStagingRelations,
  markLive,
  openProductionTransferTarget,
  recordCheckpoint,
  requireImportingRun,
  restoreSealedCollectionControls,
  scrubCheckpointCursors,
  stageReceipt,
  tableReceipt,
  withTransferTransaction,
} from "./postgres-transfer-target.mjs";

export const PRODUCTION_TRANSFER_SCHEMA = "tibotattle-pt8-lite-v1";
export const PRODUCTION_TRANSFER_INPUTS_SCHEMA = "tibotattle-pt8-lite-inputs-v1";
export const PRODUCTION_TRANSFER_AUTHORIZATION_SCHEMA = "tibotattle-pt8-lite-authorization-v1";
export const ORCHESTRATOR_LOCK_KEY = "tibotattle/production-transfer/v1";
/** C-MAINT's migration fence: POSTGRES_LIFECYCLE_PASS_MIGRATION_LOCK_PREFIX + schema (src/postgres-lifecycle-pass.ts). */
export const MIGRATION_FENCE_LOCK_PREFIX = "tibotattle:primary:";
export const POST_LIVE_MAXIMUM_PASS_AGE_MILLISECONDS = 2 * 60 * 60 * 1000;
export const SCHEDULER_EVIDENCE_MAXIMUM_AGE_MILLISECONDS = 6 * 60 * 60 * 1000;
/** Primary 0052: the nine typed identities TL-1 restarts. */
export const TYPED_IDENTITY_TABLES = Object.freeze([
  "typed_telemetry_namespaces", "typed_telemetry_owners", "typed_telemetry_devices", "typed_telemetry_manifests",
  "typed_telemetry_chunks", "typed_telemetry_identifiers", "typed_telemetry_attributions",
  "typed_telemetry_quota_dimensions", "typed_telemetry_records",
]);
const INTERIM_PUBLIC_READ_TABLE = "community_daily_frozen_export";
/**
 * The C-INFRA scheduler probe receipt (GCP_OPS_INFRA_SCHEDULER_PROBE_SCHEMA in
 * gcp-ops-infra-operations.mjs, which pulls the Cloud Run client modules; the
 * check pins the two literals equal).
 */
export const SCHEDULER_PROBE_SCHEMA = "tibotattle-gcp-ops-infra-scheduler-probe-v1";
/**
 * P11's managed trigger set is NOT a constant here: it is the key set of the
 * committed production desired state's closed `scheduler` map, which C-INFRA's
 * validator holds equal to its SCHEDULED_JOB_NAMES (gcp-ops-infra-manifest.mjs,
 * whose imports pull the Cloud SQL connector; the check pins the committed
 * keys equal to that literal). probeScheduler reports one entry per name in
 * that set, so the two cannot drift when C-INFRA adds a trigger (the
 * fast-path final line manages `maintenance` too, as design P11 requires).
 * The set must contain at least these: the refresh would publish, which ends
 * the frozen read and reads a partial import.
 */
export const REQUIRED_SCHEDULED_TRIGGERS = Object.freeze(["analytics-refresh"]);
const SCHEDULED_JOB_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const MAX_SCHEDULED_TRIGGERS = 16;
/**
 * The committed production desired state, relative to apps/worker (C-INFRA's
 * COMMITTED_DESIRED_STATE_FILES.production), and its schema literal
 * (GCP_OPS_INFRA_DESIRED_STATE_SCHEMA); the check pins both. P8 binds the pin
 * to its IDENTITY_LINK_SECRET mount and P11 binds the probe to its project
 * and its scheduler map.
 */
export const PRODUCTION_DESIRED_STATE_FILE = "cloud-run/infra/production.desired-state.json";
export const DESIRED_STATE_SCHEMA = "tibotattle-gcp-ops-infra-desired-state-v2";
const WORKER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const PUBLISHED_DAILY_TABLE = "analytics_v2_published_daily";

/** The owner-directory files. */
export const OWNER_FILES = Object.freeze({
  inputs: "pt8-inputs.json",
  pin: "identity-pin.json",
  rotation: "identity-rotation.json",
  preflight: "preflight.json",
  postImport: "post-import.json",
  release: "release-controls.json",
  flipGate: "flip-gate.json",
  markLive: "mark-live.json",
  postLiveCheck: "post-live-check.json",
  report: "pt8-report.json",
  journal: "pt8-journal.ndjson",
});

/** The steps that change the target, each needing --execute and its exact --confirm token. */
export const PROTECTED_STEPS = Object.freeze(["run", "release-controls", "mark-live", "abandon"]);
/**
 * Round 16: a run whose inputs declare an identity-link rotation also needs
 * this second, separately bound token (--confirm-identity-rotation). The run
 * token alone can never rotate the pin.
 */
export const IDENTITY_ROTATION_AUTHORIZATION_STEP = "identity-rotation";
const AUTHORIZATION_STEPS = Object.freeze([...PROTECTED_STEPS, IDENTITY_ROTATION_AUTHORIZATION_STEP]);
/** PT-8's own stage that moves the imported pin to the rotated label, and its checkpoint. */
export const IDENTITY_LINK_ROTATION_STAGE = "identity-link-rotation";
/** REV-SEED's stage (round 14): it loads the revision floor before markLive. */
export const REVISION_FLOOR_STAGE = "analytics-community-history";
const IDENTITY_LINK_ROTATION_CHECKPOINT = "identity-link-pin";
/**
 * Round 16: the labels a production rotation moves between, from the
 * origin's own configuration: `to` (and the inputs' expectedIdentityKeyVersion)
 * must be the label the origin runs, `from` a label production retired. The
 * CLI and the library API both use these; nothing injects others.
 */
export const PRODUCTION_IDENTITY_LINK_ROTATION_LABELS = Object.freeze({
  currentKeyVersion: PRODUCTION_IDENTITY_LINK_SECRET_VERSION,
  retiredKeyVersions: PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS,
});
/**
 * Every route a production registry may port (the classes it admits); the
 * P8-R consumer refusal checks the identity-link consumers against it. Every
 * consumer is retired (round 12), and this set excludes the retired classes
 * by construction, so on the CLI path the refusal reduces to the registry
 * classification (a consumer reclassified out of retired refuses). The real
 * ported set lives in
 * TypeScript (src/backend-composition.ts) that plain Node cannot load here;
 * the production host's boot refusal (assertIdentityLinkRotationComposable)
 * checks that set. The library API (the synthetic spec) may inject another
 * set; the CLI never does.
 */
export const PRODUCTION_ADMISSIBLE_PORTED_ROUTE_IDS = Object.freeze(PRODUCTION_ROUTE_TABLE
  .filter(route => ![PRODUCTION_ROUTE_CLASSES.RETIRED, PRODUCTION_ROUTE_CLASSES.RETIRED_DEFINITE,
    PRODUCTION_ROUTE_CLASSES.ROOT].includes(route.routeClass))
  .map(route => route.id));
/** The finalize order (design sections 1 and 8). */
export const FINALIZE_ORDER = Object.freeze([
  "preflight", "run", "flip-1", "release-controls", "flip-2", "flip-gate", "mark-live", "post-live-check", "report",
]);

export const PRODUCTION_TRANSFER_ERROR_CODES = Object.freeze([
  "CUTOVER_ARGUMENT_INVALID",
  "CUTOVER_AUTHORIZATION_MISMATCH",
  "CUTOVER_BOOTSTRAP_TARGET_INVALID",
  "CUTOVER_CONNECTION_INVALID",
  "CUTOVER_CORRECTION_RUNTIME_ACTIVE",
  "CUTOVER_DESIRED_STATE_INVALID",
  "CUTOVER_COVERAGE_RECEIPT_MISMATCH",
  "CUTOVER_COVERAGE_RECEIPT_MISSING",
  "CUTOVER_COVERAGE_RECEIPT_UNEXPECTED",
  "CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE",
  "CUTOVER_ERASED_PARTICIPANT_PRESENT",
  "CUTOVER_EXECUTE_REQUIRED",
  "CUTOVER_FLIP_EVIDENCE_INVALID",
  "CUTOVER_FLIP_EVIDENCE_STALE",
  "CUTOVER_IDENTITY_LINK_VERSION_MISMATCH",
  "CUTOVER_IDENTITY_ROTATION_CONSUMER_PORTED",
  "CUTOVER_IDENTITY_ROTATION_INVALID",
  "CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH",
  "CUTOVER_IDENTITY_ROTATION_SOURCE_UNREADABLE",
  "CUTOVER_IDENTITY_ROTATION_STATE_INVALID",
  "CUTOVER_INPUTS_INVALID",
  "CUTOVER_INTERIM_READ_FACTS_INVALID",
  "CUTOVER_INTERIM_READ_NOT_LOADED",
  "CUTOVER_MIGRATION_FENCE_HELD",
  "CUTOVER_ORCHESTRATOR_BUSY",
  "CUTOVER_OWNER_LINK_ERASED",
  "CUTOVER_OWNER_REVISIONS_DIVERGED",
  "CUTOVER_PARTICIPANT_ERASURE_PENDING",
  "CUTOVER_PENDING_OBJECT_CONFLICT",
  "CUTOVER_POST_LIVE_NOT_READY",
  "CUTOVER_PREFLIGHT_MISSING",
  "CUTOVER_PROJECTION_SEAL_MISMATCH",
  "CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE",
  "CUTOVER_PUBLIC_SOURCE_OWNERS_DIVERGED",
  "CUTOVER_RECEIPT_CONFLICT",
  "CUTOVER_RUNTIME_RESET_NOT_AT_SEED",
  "CUTOVER_SCHEDULER_NOT_PAUSED",
  "CUTOVER_SEAL_FENCE_MISMATCH",
  "CUTOVER_SEAL_SOURCE_COMMIT_MISMATCH",
  "CUTOVER_SPARKLE_NONCES_UNEXPIRED",
  "CUTOVER_STEP_ORDER_VIOLATION",
  "CUTOVER_TARGET_FROZEN_READ_TABLE_MISSING",
  "CUTOVER_TARGET_REVISION_FLOOR_TABLE_MISSING",
  "CUTOVER_TRANSFER_LOGIN_MEMBERSHIP_INVALID",
  "CUTOVER_TYPED_IDENTITY_HEADROOM_INVALID",
]);
const ERROR_CODES = new Set(PRODUCTION_TRANSFER_ERROR_CODES);
const SAFE_NAME = /^[a-z][a-z0-9_:.-]{0,80}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CONTRACT_ID = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_JSON_BYTES = 256 * 1024;
const HASH = value => createHash("sha256").update(value).digest("hex");
const PRIVATE_SOCKET_ROOTS = Object.freeze(["/private/tmp/", "/tmp/", "/var/folders/", "/cloudsql/", "/Users/", "/home/"]);

export class ProductionTransferError extends Error {
  constructor(code, details = undefined) {
    const safe = {};
    if (details && typeof details === "object") {
      for (const key of ["step", "stage", "table", "check", "class", "role"]) {
        if (typeof details[key] === "string" && SAFE_NAME.test(details[key])) safe[key] = details[key];
      }
      if (Number.isSafeInteger(details.count) && details.count >= 0) safe.count = details.count;
    }
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix.length > 0 ? `${code} [${suffix}]` : code);
    this.name = "ProductionTransferError";
    this.code = ERROR_CODES.has(code) ? code : "CUTOVER_ARGUMENT_INVALID";
    Object.assign(this, safe);
  }
}

function fail(code, details = undefined) {
  throw new ProductionTransferError(code, details);
}

/** The closed error classes whose message is content-free by contract. */
export function isContentFreeError(error) {
  return error instanceof ProductionTransferError || error instanceof PostgresTransferTargetError
    || error instanceof CutoverSourceError || error instanceof TransferCoverageError
    || error instanceof ParitySampleError
    || (error instanceof Error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.code)
      && typeof error.message === "string" && error.message.startsWith(error.code)
      && !/[/@\\]|https?:/u.test(error.message));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code, details = undefined) {
  if (!record(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(code, details);
  return value;
}

function sha(value, code = "CUTOVER_ARGUMENT_INVALID") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function instantMs(value) {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function quote(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_@.-]{0,62}$/u.test(name)) fail("CUTOVER_ARGUMENT_INVALID");
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Authorization tokens and the step order.

/**
 * The exact token a PROTECTED step requires: sha256 of the canonical
 * { schema, step, sealId, contractId, inputsSha256, ...evidence }. Any change
 * to the seal, the contract, the inputs or the step's evidence changes it.
 */
export function authorizationToken(step, bindings) {
  if (!AUTHORIZATION_STEPS.includes(step) || !record(bindings)) fail("CUTOVER_ARGUMENT_INVALID", { step });
  for (const [key, value] of Object.entries(bindings)) {
    if (!/^[a-z][A-Za-z0-9]{0,40}$/u.test(key) || (typeof value !== "string" && value !== null)) {
      fail("CUTOVER_ARGUMENT_INVALID", { step });
    }
  }
  sha(bindings.sealId);
  if (typeof bindings.contractId !== "string" || !CONTRACT_ID.test(bindings.contractId)) fail("CUTOVER_ARGUMENT_INVALID");
  sha(bindings.inputsSha256);
  return HASH(canonicalJson({ schema: PRODUCTION_TRANSFER_AUTHORIZATION_SCHEMA, step, ...bindings }));
}

function authorize(step, token, { execute, confirm }) {
  if (execute !== true) return false;
  if (typeof confirm !== "string" || confirm !== token) fail("CUTOVER_AUTHORIZATION_MISMATCH", { step });
  return true;
}

/**
 * The finalize order as a pure state check. `observed` carries the run state
 * (null before beginRun) and whether preflight.json, release-controls.json and
 * flip-gate.json exist. Each violation is CUTOVER_STEP_ORDER_VIOLATION naming
 * the step.
 */
export function assertStepOrder(step, observed) {
  if (!record(observed)) fail("CUTOVER_ARGUMENT_INVALID");
  const { runState = null, preflight = false, released = false, flipGate = false } = observed;
  const violation = () => fail("CUTOVER_STEP_ORDER_VIOLATION", { step });
  switch (step) {
    case "run":
      if (!preflight || ["live", "abandoned"].includes(runState)) violation();
      return;
    case "release-controls":
      if (runState !== "verified") violation();
      return;
    case "flip-gate":
      if (runState !== "verified" || !released) violation();
      return;
    case "mark-live":
      if (!["verified", "live"].includes(runState) || !released || !flipGate) violation();
      return;
    case "post-live-check":
    case "report":
      if (runState !== "live") violation();
      return;
    case "abandon":
      if (runState === null || ["live", "abandoned"].includes(runState)) violation();
      return;
    default:
      fail("CUTOVER_ARGUMENT_INVALID", { step });
  }
}

// ---------------------------------------------------------------------------
// The owner directory: inputs, receipts and the advisory journal.

function absolutePath(value, code = "CUTOVER_INPUTS_INVALID") {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || resolve(value) !== value) fail(code);
  return value;
}

/**
 * Validate a parsed pt8-inputs.json (closed keys). identityLinkRotation is
 * the one optional key: { rotationSha256 }, the sha256 of the owner
 * directory's identity-rotation.json (round 16). Its presence switches P8 to
 * P8-R and requires the identity-rotation token at `run`. adminHistoryExport
 * is { path, sha256 }: H.3 step 6's analytics D1 export
 * (cutover-admin-history-export.mjs), which post-import's admin history
 * mapping requires and P15 binds to the seal. revisionFloor is { path,
 * sha256 }: H.3 step 7's revision-floor.json (cutover-revision-floor.mjs
 * capture, or its synthetic floor at the dress rehearsal), which the
 * 'analytics-community-history' stage loads and P16 binds to the seal and
 * the frozen read. fenceReceiptPath is the EP-8 fence receipt itself (the
 * file whose sha256 is fenceReceiptSha256 and the seal's pin): P16 and the
 * stage read its analytics entry, which a captured floor must name.
 */
export function validateTransferInputs(value) {
  const keys = ["schema", "contractId", "sealId", "sealManifestPath", "expectedSourceCommit", "fenceReceiptSha256",
    "fenceReceiptPath", "expectedIdentityKeyVersion", "deletionDigestProjection", "interimPublicRead", "adminHistoryExport",
    "revisionFloor", "schedulerEvidencePath", "ownerFlags", "allowedRoleMembers"];
  const rotationDeclared = record(value) && Object.hasOwn(value, "identityLinkRotation");
  exactKeys(value, rotationDeclared ? [...keys, "identityLinkRotation"] : keys, "CUTOVER_INPUTS_INVALID");
  if (rotationDeclared) {
    exactKeys(value.identityLinkRotation, ["rotationSha256"], "CUTOVER_INPUTS_INVALID");
    sha(value.identityLinkRotation.rotationSha256, "CUTOVER_INPUTS_INVALID");
  }
  if (value.schema !== PRODUCTION_TRANSFER_INPUTS_SCHEMA || typeof value.contractId !== "string"
      || !CONTRACT_ID.test(value.contractId) || typeof value.expectedSourceCommit !== "string"
      || !COMMIT.test(value.expectedSourceCommit) || typeof value.expectedIdentityKeyVersion !== "string"
      || !KEY_VERSION.test(value.expectedIdentityKeyVersion)) {
    fail("CUTOVER_INPUTS_INVALID");
  }
  sha(value.sealId, "CUTOVER_INPUTS_INVALID");
  sha(value.fenceReceiptSha256, "CUTOVER_INPUTS_INVALID");
  absolutePath(value.fenceReceiptPath);
  absolutePath(value.sealManifestPath);
  absolutePath(value.schedulerEvidencePath);
  exactKeys(value.deletionDigestProjection, ["path", "sha256"], "CUTOVER_INPUTS_INVALID");
  absolutePath(value.deletionDigestProjection.path);
  sha(value.deletionDigestProjection.sha256, "CUTOVER_INPUTS_INVALID");
  exactKeys(value.adminHistoryExport, ["path", "sha256"], "CUTOVER_INPUTS_INVALID");
  absolutePath(value.adminHistoryExport.path);
  sha(value.adminHistoryExport.sha256, "CUTOVER_INPUTS_INVALID");
  exactKeys(value.revisionFloor, ["path", "sha256"], "CUTOVER_INPUTS_INVALID");
  absolutePath(value.revisionFloor.path);
  sha(value.revisionFloor.sha256, "CUTOVER_INPUTS_INVALID");
  const interim = exactKeys(value.interimPublicRead, ["exportPath", "sha256", "capturedAt", "sourceCommit", "evidenceDate"],
    "CUTOVER_INPUTS_INVALID");
  absolutePath(interim.exportPath);
  sha(interim.sha256, "CUTOVER_INPUTS_INVALID");
  if (instantMs(interim.capturedAt) === null || typeof interim.sourceCommit !== "string" || !COMMIT.test(interim.sourceCommit)
      || typeof interim.evidenceDate !== "string" || !DAY.test(interim.evidenceDate)) {
    fail("CUTOVER_INPUTS_INVALID");
  }
  try {
    validateOwnerFlags(value.ownerFlags);
  } catch {
    fail("CUTOVER_INPUTS_INVALID");
  }
  if (!Array.isArray(value.allowedRoleMembers) || value.allowedRoleMembers.length > 8
      || new Set(value.allowedRoleMembers).size !== value.allowedRoleMembers.length
      || value.allowedRoleMembers.some(member => typeof member !== "string" || !ROLE_NAME.test(member))) {
    fail("CUTOVER_INPUTS_INVALID");
  }
  return Object.freeze({ ...value, ownerFlags: Object.freeze([...value.ownerFlags].sort()),
    allowedRoleMembers: Object.freeze([...value.allowedRoleMembers].sort()),
    ...(rotationDeclared ? { identityLinkRotation: Object.freeze({ ...value.identityLinkRotation }) } : {}) });
}

async function readOwnerJson(path, code) {
  const bytes = await readPrivateFile(path, MAX_JSON_BYTES, code);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256Hex(bytes) };
  } catch {
    return fail(code);
  }
}

async function fileExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return fail("CUTOVER_ARGUMENT_INVALID");
  }
}

/**
 * Write a receipt once (0400). A rerun that produces the identical bytes
 * reuses the file; different bytes are CUTOVER_RECEIPT_CONFLICT.
 */
async function writeReceiptOnce(path, value) {
  const text = `${canonicalJson(value)}\n`;
  if (await fileExists(path)) {
    const existing = await readPrivateFile(path, MAX_JSON_BYTES, "CUTOVER_RECEIPT_CONFLICT");
    if (existing.toString("utf8") !== text) fail("CUTOVER_RECEIPT_CONFLICT");
    return sha256Hex(existing);
  }
  return writePrivateFileOnce(path, text, 0o400);
}

async function journal(context, step, event, details = {}) {
  const line = { at: context.now().toISOString(), step, event };
  for (const [key, value] of Object.entries(details)) {
    if ((typeof value === "string" && SAFE_NAME.test(value)) || (typeof value === "string" && SHA256.test(value))
        || Number.isSafeInteger(value) || typeof value === "boolean") {
      line[key] = value;
    }
  }
  try {
    await appendFile(join(context.ownerDirectory, OWNER_FILES.journal), `${JSON.stringify(line)}\n`,
      { mode: 0o600, flag: "a" });
  } catch {
    // Advisory only: the database is authoritative.
  }
}

/**
 * The context every subcommand shares: the validated owner directory and
 * inputs, the target pool (an injected pg.Pool connected as the transfer IAM
 * login), a clock, the committed production desired state and the test
 * hooks. The CLI always uses the committed desired-state file; only the
 * library API (the synthetic spec) passes another path.
 */
export async function createTransferContext({ ownerDirectory, pool, now = () => new Date(), onStep = null,
  runnerOptions = {}, forbiddenRoots = undefined, rootDirectory = undefined,
  desiredStatePath = join(WORKER_ROOT, PRODUCTION_DESIRED_STATE_FILE),
  portedRouteIds = PRODUCTION_ADMISSIBLE_PORTED_ROUTE_IDS } = {}) {
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  if (onStep !== null && typeof onStep !== "function") fail("CUTOVER_ARGUMENT_INVALID");
  absolutePath(desiredStatePath, "CUTOVER_ARGUMENT_INVALID");
  if (!Array.isArray(portedRouteIds) || portedRouteIds.some(id => typeof id !== "string")) fail("CUTOVER_ARGUMENT_INVALID");
  if (!record(runnerOptions) || Object.keys(runnerOptions).some(key => !["pageRows", "pageBytes", "onPage"].includes(key))) {
    fail("CUTOVER_ARGUMENT_INVALID");
  }
  const raw = await readOwnerJson(join(directory, OWNER_FILES.inputs), "CUTOVER_INPUTS_INVALID");
  const inputs = validateTransferInputs(raw.value);
  return Object.freeze({
    ownerDirectory: directory,
    inputs,
    inputsSha256: raw.sha256,
    pool,
    now,
    onStep,
    runnerOptions: Object.freeze({ ...runnerOptions }),
    rootDirectory,
    desiredStatePath,
    portedRouteIds: Object.freeze([...portedRouteIds]),
    path: name => join(directory, OWNER_FILES[name]),
  });
}

async function step(context, name, details = {}) {
  await journal(context, name, "committed", details);
  if (context.onStep !== null) await context.onStep(name);
}

// ---------------------------------------------------------------------------
// The seal (public seal exports only) and the target handle.

async function openSeal(context) {
  const seal = await readCutoverSeal({ manifestPath: context.inputs.sealManifestPath, expectedSealId: context.inputs.sealId });
  const sources = {};
  try {
    for (const role of CUTOVER_SOURCE_ROLES) {
      sources[role] = await openSealedSourceFromSeal(seal, role);
      await sources[role].verify();
    }
  } catch (error) {
    for (const source of Object.values(sources)) source.close();
    throw error;
  }
  return {
    seal,
    sources,
    database: role => sources[role].database(),
    async verify() {
      for (const source of Object.values(sources)) await source.verify();
    },
    close() {
      for (const source of Object.values(sources)) source.close();
    },
  };
}

async function withSeal(context, fn) {
  const sealed = await openSeal(context);
  try {
    const result = await fn(sealed);
    await sealed.verify();
    return result;
  } finally {
    sealed.close();
  }
}

function openHandle(context) {
  return openProductionTransferTarget({
    primaryPool: context.pool,
    expectedContractId: context.inputs.contractId,
    sealManifestSha256: context.inputs.sealId,
    ...(context.rootDirectory === undefined ? {} : { rootDirectory: context.rootDirectory }),
  });
}

/** The current run row (any state but abandoned) of this seal, read-only. */
async function readRunFacts(handle) {
  return withTransferTransaction(handle, "primary", async client => {
    const { rows } = await client.query(`SELECT run_id, state, flip_evidence_sha256,
        to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS verified_at
      FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_runs WHERE seal_manifest_sha256 = $1 AND contract_id = $2
        AND state <> 'abandoned'`, [handle.sealManifestSha256, handle.contractId]);
    if (rows.length > 1) fail("CUTOVER_STEP_ORDER_VIOLATION");
    return rows.length === 0 ? null : Object.freeze({ runId: rows[0].run_id, state: rows[0].state,
      flipEvidenceSha256: rows[0].flip_evidence_sha256, verifiedAt: rows[0].verified_at });
  }, { readOnly: true });
}

/**
 * The session advisory lock that admits one orchestrator, and C-MAINT's
 * shared migration fence so no migration commits mid-import, both on one
 * dedicated connection held for the whole step.
 */
async function withOrchestratorLocks(context, schema, fn) {
  let client;
  try {
    client = await context.pool.connect();
  } catch {
    fail("CUTOVER_CONNECTION_INVALID");
  }
  const locked = { orchestrator: false, fence: false };
  try {
    const own = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [ORCHESTRATOR_LOCK_KEY]);
    if (own.rows[0]?.acquired !== true) fail("CUTOVER_ORCHESTRATOR_BUSY");
    locked.orchestrator = true;
    const fence = await client.query("SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0)) AS acquired",
      [`${MIGRATION_FENCE_LOCK_PREFIX}${schema}`]);
    if (fence.rows[0]?.acquired !== true) fail("CUTOVER_MIGRATION_FENCE_HELD");
    locked.fence = true;
    return await fn();
  } finally {
    try {
      if (locked.fence) {
        await client.query("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))", [`${MIGRATION_FENCE_LOCK_PREFIX}${schema}`]);
      }
      if (locked.orchestrator) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [ORCHESTRATOR_LOCK_KEY]);
      client.release();
    } catch {
      client.release(true);
    }
  }
}

/**
 * The production counterparts of the rehearsal-only compareFastpath*
 * checks (postgres-fastpath-identity-copy.mjs refuses any schema outside its
 * rehearsal prefix), with the same canonical lines: each side is read by its
 * own engine and compared as sorted JSON lines. They run inside the
 * transfer handle's read-only transaction (SET LOCAL ROLE to the schema owner).
 */
const compareLines = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

async function compareOwnerRevisions(handle, database) {
  const sourceState = sealedRows(database, "SELECT source_id FROM storage_source_state WHERE singleton = 1");
  const canonical = rows => rows.map(row => JSON.stringify([row.owner_digest, String(row.revision),
    String(row.authority_epoch), row.state])).sort(compareLines);
  const sourceLines = canonical(sealedRows(database,
    "SELECT owner_digest, revision, authority_epoch, state FROM storage_owner_revisions"));
  return withTransferTransaction(handle, "primary", async client => {
    const schema = quote(handle.primarySchema);
    const { rows: state } = await client.query(`SELECT source_id FROM ${schema}.storage_source_state WHERE singleton = 1`);
    const { rows } = await client.query(`SELECT owner_digest, revision::text AS revision,
        authority_epoch::text AS authority_epoch, state FROM ${schema}.storage_owner_revisions
       WHERE source_id = (SELECT source_id FROM ${schema}.storage_source_state WHERE singleton = 1)`);
    const targetLines = canonical(rows);
    const sourceSha256 = HASH(sourceLines.join("\n"));
    const targetSha256 = HASH(targetLines.join("\n"));
    const sourceIdMatches = sourceState.length === 1 && state.length === 1 && sourceState[0].source_id === state[0].source_id;
    return Object.freeze({ sourceIdMatches, sourceRows: sourceLines.length, targetRows: targetLines.length, sourceSha256,
      targetSha256, equal: sourceIdMatches && sourceSha256 === targetSha256 });
  }, { readOnly: true });
}

async function comparePublicSourceOwners(handle, database) {
  const lines = rows => rows.map(row => JSON.stringify([row.participant_id, row.owner_kind, row.device_id ?? null]))
    .sort(compareLines);
  const view = sealedRows(database, "SELECT type FROM sqlite_schema WHERE name = 'community_public_source_owners'");
  if (view.length !== 1 || view[0].type !== "view") fail("CUTOVER_PUBLIC_SOURCE_OWNERS_DIVERGED");
  const sourceLines = lines(sealedRows(database, "SELECT participant_id, owner_kind, device_id FROM community_public_source_owners"));
  return withTransferTransaction(handle, "primary", async client => {
    const { rows } = await client.query(`SELECT participant_id, owner_kind, device_id
      FROM ${quote(handle.primarySchema)}.community_public_source_owners`);
    const targetLines = lines(rows);
    return Object.freeze({ sourceRows: sourceLines.length, targetRows: targetLines.length,
      equal: HASH(sourceLines.join("\n")) === HASH(targetLines.join("\n")) });
  }, { readOnly: true });
}

// ---------------------------------------------------------------------------
// Sealed facts shared by preflight and the run.

function sealedRows(database, sql, values = []) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...values);
}

function sealedCount(database, sql) {
  const [row] = sealedRows(database, sql);
  return Number(row?.n ?? -1n);
}

function correctionRuntimeCheck(database) {
  const runtime = sealedRows(database, "SELECT state FROM telemetry_usage_correction_runtime");
  const facts = sealedCount(database, "SELECT count(*) AS n FROM telemetry_usage_correction_facts");
  const history = sealedCount(database, "SELECT count(*) AS n FROM telemetry_usage_correction_history");
  const guard = sealedCount(database, "SELECT count(*) AS n FROM telemetry_usage_correction_cas_guard");
  if (runtime.length !== 1 || runtime[0].state !== CORRECTION_RUNTIME_STAGED_STATE || facts !== 0 || history !== 0 || guard !== 0) {
    fail("CUTOVER_CORRECTION_RUNTIME_ACTIVE", { check: "P4" });
  }
  return Object.freeze({ runtimeRows: 1, state: CORRECTION_RUNTIME_STAGED_STATE, facts, history, casGuard: guard });
}

function erasureQuiescenceCheck(ingestion, ledger) {
  const notQuiescent = sealedCount(ingestion, `SELECT count(*) AS n FROM participants WHERE ${PARTICIPANT_NOT_QUIESCENT_PREDICATE}`);
  if (notQuiescent !== 0) fail("CUTOVER_PARTICIPANT_ERASURE_PENDING", { check: "P5", count: notQuiescent });
  const pendingJobs = sealedCount(ledger, "SELECT count(*) AS n FROM storage_erasure_jobs WHERE state = 'pending'");
  if (pendingJobs !== 0) fail("CUTOVER_PARTICIPANT_ERASURE_PENDING", { check: "P5", count: pendingJobs });
  // A link marked erased whose participant row still exists is an erasure
  // that has not completed (the link cascades away with its participant).
  const erasedLinks = sealedCount(ingestion, "SELECT count(*) AS n FROM storage_v11_owner_links WHERE state = 'erased'");
  if (erasedLinks !== 0) fail("CUTOVER_OWNER_LINK_ERASED", { check: "P5", count: erasedLinks });
  return Object.freeze({ notQuiescentParticipants: 0, pendingErasureJobs: 0, erasedOwnerLinks: 0 });
}

async function deletionDigestCheck(context, sealed) {
  const projection = await readDeletionDigestProjection({ path: context.inputs.deletionDigestProjection.path,
    expectedSha256: context.inputs.deletionDigestProjection.sha256 });
  const fromSeal = await readSealedDeletionDigests({ sealedLedger: sealed.sources["deletion-ledger"] });
  if (fromSeal.sha256 !== context.inputs.deletionDigestProjection.sha256 || fromSeal.count !== projection.size) {
    fail("CUTOVER_PROJECTION_SEAL_MISMATCH", { check: "P6" });
  }
  const counted = await countSealedParticipantDeletionMatches({ sealedIngestion: sealed.sources.ingestion, digests: projection });
  const report = Object.freeze({
    tombstoneDigests: projection.size,
    projectionSha256: context.inputs.deletionDigestProjection.sha256,
    participants: Object.freeze({ active: counted.participantsByState.active, deleting: counted.participantsByState.deleting }),
    matches: counted.matches,
  });
  if (counted.matches !== 0) fail("CUTOVER_ERASED_PARTICIPANT_PRESENT", { check: "P6", count: counted.matches });
  return { report, digests: projection };
}

function bootstrapCheck(database) {
  const rows = sealedRows(database, "SELECT singleton, policy_version, completed FROM community_public_source_bootstrap");
  if (rows.length !== 1 || rows[0].singleton !== 1n || rows[0].policy_version !== PUBLIC_SOURCE_BOOTSTRAP_POLICY
      || rows[0].completed !== 1n) {
    fail("CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE", { check: "P7" });
  }
  return Object.freeze({ policyVersion: PUBLIC_SOURCE_BOOTSTRAP_POLICY, completed: 1 });
}

async function readPin(context) {
  const { value, sha256 } = await readOwnerJson(context.path("pin"), "CUTOVER_INPUTS_INVALID");
  return { pin: validateIdentityLinkPin(value), sha256 };
}

/**
 * The declared identity-link rotation (round 16), or null when the inputs
 * declare none. The document must hash to the inputs' rotationSha256 (it is
 * tamper-evident: the run token binds the inputs, which bind this digest)
 * and be the closed rotation schema naming exactly the registry's consumer
 * routes; anything else refuses CUTOVER_IDENTITY_ROTATION_INVALID. Its labels
 * and the inputs' expectedIdentityKeyVersion are tied to the origin's
 * configuration (PRODUCTION_IDENTITY_LINK_ROTATION_LABELS): `to` and the
 * expected label must be the label the origin runs and `from` a retired one,
 * at every step that reads the rotation (CUTOVER_IDENTITY_LINK_VERSION_MISMATCH).
 */
async function readRotation(context) {
  const declared = context.inputs.identityLinkRotation;
  if (declared === undefined) return null;
  if (context.inputs.expectedIdentityKeyVersion !== PRODUCTION_IDENTITY_LINK_ROTATION_LABELS.currentKeyVersion) {
    fail("CUTOVER_IDENTITY_LINK_VERSION_MISMATCH", { check: "P8" });
  }
  const { value, sha256 } = await readOwnerJson(context.path("rotation"), "CUTOVER_IDENTITY_ROTATION_INVALID");
  if (sha256 !== declared.rotationSha256) fail("CUTOVER_IDENTITY_ROTATION_INVALID", { check: "P8" });
  const rotation = validateIdentityLinkRotation(value, { consumerRouteIds: IDENTITY_LINK_CONSUMER_ROUTE_IDS });
  assertRotationLabels({ fromKeyVersion: rotation.from.keyVersion, toKeyVersion: rotation.to.keyVersion },
    PRODUCTION_IDENTITY_LINK_ROTATION_LABELS);
  return Object.freeze({ rotation, rotationSha256: sha256 });
}

/**
 * P8-R's consumer refusal: a rotation is admitted only while every route
 * that consumes the identity-link pin, link keys or cooldown digests is
 * retired in the registry and outside the ported set (round 12 retires them
 * all). On the CLI path the ported set is PRODUCTION_ADMISSIBLE_PORTED_ROUTE_IDS,
 * so what this proves at preflight is the registry classification; the real
 * ported set is refused at host boot. The PostgreSQL lifecycle pass reads no
 * identity secret; the check pins that statically.
 */
function identityLinkConsumersCheck(portedRouteIds) {
  try {
    return assertIdentityLinkConsumersRetired([...portedRouteIds]);
  } catch {
    return fail("CUTOVER_IDENTITY_ROTATION_CONSUMER_PORTED", { check: "P8" });
  }
}

/** The identity-rotation token: bound to the seal, contract, inputs, preflight and the rotation document. */
function identityRotationToken(context, preflightSha256, { rotation, rotationSha256 }) {
  return authorizationToken(IDENTITY_ROTATION_AUTHORIZATION_STEP, { sealId: context.inputs.sealId,
    contractId: context.inputs.contractId, inputsSha256: context.inputsSha256, preflightSha256, rotationSha256,
    fromKeyVersion: rotation.from.keyVersion, toKeyVersion: rotation.to.keyVersion,
    toSecretVersion: rotation.to.secretVersion });
}

function controlsCheck(database) {
  const rows = sealedRows(database, "SELECT upload_registration_enabled, processing_enabled FROM collection_controls");
  if (rows.length !== 1 || (rows[0].upload_registration_enabled !== 1n && rows[0].processing_enabled !== 1n)) {
    fail("CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE", { check: "P9" });
  }
  return Object.freeze({ degradable: true });
}

/**
 * The committed production desired state, read as data (not through C-INFRA's
 * validator module, whose imports need the Cloud SQL connector): the project
 * and the managed trigger set (the `scheduler` map's keys, sorted) that the
 * scheduler probe must name (P11), and the IDENTITY_LINK_SECRET mount the
 * identity pin must name (P8). An unfilled project placeholder, or a scheduler
 * map that is not a set of job names including REQUIRED_SCHEDULED_TRIGGERS,
 * refuses here; an unpinned mount version refuses at P8
 * (CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED).
 */
export async function readProductionDeployment(path) {
  let value;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > MAX_JSON_BYTES) throw new Error("not a desired-state file");
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("CUTOVER_DESIRED_STATE_INVALID", { check: "desired-state" });
  }
  const mount = value?.secrets?.IDENTITY_LINK_SECRET;
  const triggers = record(value?.scheduler) ? Object.keys(value.scheduler).sort() : [];
  if (!record(value) || value.schemaVersion !== DESIRED_STATE_SCHEMA || value.environment !== "production"
      || typeof value.project !== "string" || !GCP_PROJECT.test(value.project)
      || !record(mount) || Object.keys(mount).sort().join(",") !== "secretName,version"
      || triggers.length > MAX_SCHEDULED_TRIGGERS || triggers.some(job => !SCHEDULED_JOB_NAME.test(job))
      || REQUIRED_SCHEDULED_TRIGGERS.some(job => !triggers.includes(job))) {
    fail("CUTOVER_DESIRED_STATE_INVALID", { check: "desired-state" });
  }
  return Object.freeze({ project: value.project, scheduledTriggers: Object.freeze(triggers),
    identityLinkMount: Object.freeze({ secretName: mount.secretName, version: mount.version }) });
}

/**
 * P11 over a parsed C-INFRA scheduler probe receipt (probeScheduler in
 * gcp-ops-infra-operations.mjs): the production environment and project, no
 * alert, exactly one entry per managed trigger (`managed`: the committed
 * desired state's scheduler keys, from readProductionDeployment), every one
 * live PAUSED, and a strict checkedAt no earlier than the fence apply
 * instant, not in the future and at most 6 h old at `nowMs`.
 */
export function validateSchedulerEvidence(value, { project, managed, appliedMs, nowMs }) {
  const checkedMs = instantMs(value?.checkedAt);
  const triggers = Array.isArray(value?.triggers) ? value.triggers : null;
  const jobs = triggers === null ? [] : triggers.map(trigger => (record(trigger) ? trigger.job : null));
  const expected = Array.isArray(managed) && managed.every(job => typeof job === "string" && SCHEDULED_JOB_NAME.test(job))
      && new Set(managed).size === managed.length && REQUIRED_SCHEDULED_TRIGGERS.every(job => managed.includes(job))
    ? [...managed].sort() : null;
  if (!record(value) || value.schema !== SCHEDULER_PROBE_SCHEMA || value.environment !== "production"
      || typeof project !== "string" || value.project !== project || value.alert !== false
      || expected === null || triggers === null || triggers.length !== expected.length
      || [...jobs].sort().join("\n") !== expected.join("\n")
      || triggers.some(trigger => !record(trigger) || trigger.liveState !== "PAUSED")
      || checkedMs === null || !Number.isFinite(appliedMs) || !Number.isFinite(nowMs) || checkedMs < appliedMs
      || checkedMs > nowMs || nowMs - checkedMs > SCHEDULER_EVIDENCE_MAXIMUM_AGE_MILLISECONDS) {
    fail("CUTOVER_SCHEDULER_NOT_PAUSED", { check: "P11" });
  }
  return triggers.length;
}

async function schedulerCheck(context, seal, deployment) {
  const { value, sha256 } = await readOwnerJson(context.inputs.schedulerEvidencePath, "CUTOVER_SCHEDULER_NOT_PAUSED");
  const triggersPaused = validateSchedulerEvidence(value, { project: deployment.project,
    managed: deployment.scheduledTriggers, appliedMs: Date.parse(seal.manifest.fence?.window?.appliedAt ?? ""),
    nowMs: context.now().getTime() });
  return Object.freeze({ evidenceSha256: sha256, triggersPaused, jobs: deployment.scheduledTriggers });
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function interimReadCheck(context, seal) {
  const facts = context.inputs.interimPublicRead;
  const exportBytes = await readInterimExportFile(facts.exportPath);
  const { prepared, receipt } = await checkInterimPublicRead({ exportBytes, sha256: facts.sha256,
    capturedAt: facts.capturedAt, sourceCommit: facts.sourceCommit, evidenceDate: facts.evidenceDate });
  const sealMs = Date.parse(seal.manifest.createdAt);
  const appliedMs = Date.parse(seal.manifest.fence?.window?.appliedAt ?? "");
  const allowedDays = [utcDay(sealMs), utcDay(sealMs - 86_400_000)];
  if (!allowedDays.includes(facts.evidenceDate)) fail("CUTOVER_INTERIM_READ_FACTS_INVALID", { check: "evidence-date" });
  if (!Number.isFinite(appliedMs) || instantMs(facts.capturedAt) > appliedMs) {
    fail("CUTOVER_INTERIM_READ_FACTS_INVALID", { check: "captured-before-fence" });
  }
  if (facts.sourceCommit !== seal.manifest.expectedSourceCommit) {
    fail("CUTOVER_INTERIM_READ_FACTS_INVALID", { check: "source-commit" });
  }
  return { prepared, receipt: Object.freeze({ payloadSha256: receipt.payloadSha256, evidenceDate: receipt.evidenceDate,
    capturedAt: receipt.capturedAt }) };
}

/**
 * REV-SEED: the owner's revision floor at its pinned sha256, bound to this
 * seal (id, fence receipt, source commit), taken inside this fence, and at
 * or above every revision the frozen read serves
 * (REVISION_FLOOR_BELOW_FROZEN_EXPORT). A captured floor's capture block
 * must name the fence receipt's analytics D1 and bookmark (the receipt read
 * at the seal's pin; REVISION_FLOOR_CAPTURE_FENCE_MISMATCH). A synthetic
 * floor covers only the frozen export's days at pre-fence revisions, so it
 * needs the dress-rehearsal owner flag, and the flag refuses a captured floor
 * (REVISION_FLOOR_PROVENANCE_REFUSED). Read-only.
 */
async function revisionFloorCheck(context, seal) {
  const facts = revisionFloorSealFacts(seal);
  const floor = assertRevisionFloorBinding(await readRevisionFloorFile({ path: context.inputs.revisionFloor.path,
    expectedSha256: context.inputs.revisionFloor.sha256 }), facts);
  const provenance = await checkRevisionFloorProvenance({ floor, fenceReceiptPath: context.inputs.fenceReceiptPath,
    fenceReceiptSha256: facts.fenceReceiptSha256,
    syntheticAdmitted: context.inputs.ownerFlags.includes(OWNER_FLAG_DRESS_REHEARSAL_SYNTHETIC_REVISION_FLOOR) });
  const { prepared } = await interimReadCheck(context, seal);
  const covered = assertRevisionFloorCoversFrozen(floor, prepared.frozen.days);
  return { floor, receipt: Object.freeze({ ...revisionFloorSummary(floor), fenceBound: provenance.fenceBound,
    frozenDaysCovered: covered.frozenDays }) };
}

function sparkleNonceCount(database, atSeconds) {
  return sealedCount(database, `SELECT count(*) AS n FROM sparkle_appcast_guard_nonces WHERE expires_at > ${Math.floor(atSeconds)}`);
}

// ---------------------------------------------------------------------------
// Target checks (read-only).

async function targetFacts(handle, { requireEmptyFrozenRead = true } = {}) {
  return withTransferTransaction(handle, "primary", async client => {
    const coverage = await assertTriggerPolicyCoverage(client, handle.primarySchema, COMPLETE_TRIGGER_POLICY);
    const { rows: tables } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS frozen, to_regclass($2) IS NOT NULL AS published,
        to_regclass($3) IS NOT NULL AS floor, to_regclass($4) IS NOT NULL AS floor_source`,
      [`${quote(handle.primarySchema)}.${INTERIM_PUBLIC_READ_TABLE}`, `${quote(handle.primarySchema)}.${PUBLISHED_DAILY_TABLE}`,
        `${quote(handle.primarySchema)}.${REVISION_FLOOR_TABLES.floor}`,
        `${quote(handle.primarySchema)}.${REVISION_FLOOR_TABLES.source}`]);
    if (tables[0]?.frozen !== true || tables[0]?.published !== true) fail("CUTOVER_TARGET_FROZEN_READ_TABLE_MISSING");
    // REV-SEED: the 'analytics-community-history' stage loads the floor here.
    if (tables[0]?.floor !== true || tables[0]?.floor_source !== true) fail("CUTOVER_TARGET_REVISION_FLOOR_TABLE_MISSING");
    if (requireEmptyFrozenRead) {
      // A published day ends the frozen read; only a refresh writes one.
      const { rows } = await client.query(`SELECT (SELECT count(*) FROM ${quote(handle.primarySchema)}.${PUBLISHED_DAILY_TABLE})::int AS published`);
      if (rows[0].published !== 0) fail("CUTOVER_TARGET_FROZEN_READ_TABLE_MISSING");
    }
    await transferLoginCheck(client, handle);
    return Object.freeze({ triggerTables: coverage.tables, triggers: coverage.triggers, suppressed: coverage.suppressed });
  }, { readOnly: true });
}

/**
 * P10's identity half: the transfer login reaches the schema owner and
 * tibotattle_source_transfer by SET only, never by inheritance, and no role
 * but the owner (PUBLIC included) holds a privilege on the transfer control
 * schema or anything in it: PT-1's own flip-gate predicate, so preflight
 * refuses what assertFlipReady would refuse only after the whole import.
 */
async function transferLoginCheck(client, handle) {
  const { rows: memberships } = await client.query(`SELECT role.rolname::text AS role, am.set_option, am.inherit_option
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles role ON role.oid = am.roleid
      JOIN pg_catalog.pg_roles member ON member.oid = am.member
     WHERE member.rolname = $1 AND role.rolname = ANY($2::text[])`,
  [handle.iamDatabaseUser, [handle.schemaOwnerRole, "tibotattle_source_transfer"]]);
  for (const role of [handle.schemaOwnerRole, "tibotattle_source_transfer"]) {
    const grants = memberships.filter(row => row.role === role);
    if (grants.length === 0 || grants.some(row => row.set_option !== true || row.inherit_option !== false)) {
      fail("CUTOVER_TRANSFER_LOGIN_MEMBERSHIP_INVALID", { check: "P10" });
    }
  }
  try {
    await assertNoRuntimePrivilege(client);
  } catch (error) {
    if (error instanceof PostgresTransferTargetError && error.code === "CUTOVER_FLIP_RUNTIME_PRIVILEGE") {
      fail("CUTOVER_TRANSFER_LOGIN_MEMBERSHIP_INVALID", { check: "P10" });
    }
    throw error;
  }
}

/** Read-only, before the fence: the target accepts a fresh import (no seal needed). */
export async function targetCheck({ pool, contractId, rootDirectory = undefined }) {
  if (typeof contractId !== "string" || !CONTRACT_ID.test(contractId)) fail("CUTOVER_ARGUMENT_INVALID");
  const placeholder = HASH("tibotattle-pt8-lite-target-check-v1");
  const handle = await openProductionTransferTarget({ primaryPool: pool, expectedContractId: contractId,
    sealManifestSha256: placeholder, ...(rootDirectory === undefined ? {} : { rootDirectory }) });
  if (handle.resumed) fail("CUTOVER_STEP_ORDER_VIOLATION", { step: "target-check" });
  const facts = await targetFacts(handle);
  return Object.freeze({ schema: PRODUCTION_TRANSFER_SCHEMA, step: "target-check", contractId: handle.contractId,
    mode: handle.mode, empty: true, target: facts, verdict: "GO" });
}

// ---------------------------------------------------------------------------
// Identity pin (owner only).

/**
 * OWNER ONLY (round 16). The NEW secret from stdin, the sealed D1 pin from
 * the --sealed-pin-file (read-only wrangler SELECT output). Writes
 * identity-pin.json for the new secret under `toKeyVersion` and
 * identity-rotation.json, each 0400 and once. Prints only the labels, the
 * version number and the two files' sha256.
 */
export async function writeIdentityRotation({ ownerDirectory, stream, sealedPinFile, fromKeyVersion, toKeyVersion,
  secretName, secretVersion, now = () => new Date(), forbiddenRoots = undefined }) {
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  // The labels first, before the sealed pin or the secret is read: production
  // rotates only from a retired label to the label the origin runs.
  assertRotationLabels({ fromKeyVersion, toKeyVersion }, PRODUCTION_IDENTITY_LINK_ROTATION_LABELS);
  const sealedPath = absolutePath(sealedPinFile, "CUTOVER_ARGUMENT_INVALID");
  let sealedBytes;
  try {
    // A private file only: no group or other bits, one link, the caller's own,
    // no symlink in the path, 1 byte to 64 KiB. A plain shell redirect under
    // the usual umask is 0644; write it under `umask 077` (or chmod 400).
    sealedBytes = await readPrivateFile(sealedPath, 64 * 1024, "CUTOVER_ARGUMENT_INVALID");
  } catch {
    fail("CUTOVER_IDENTITY_ROTATION_SOURCE_UNREADABLE", { step: "identity-rotate-pin" });
  }
  const sealedPin = parseSealedPinFile(sealedBytes);
  // The sealed pin must carry the retired label named, checked before the
  // secret is read (the builder refuses it again).
  if (sealedPin.keyVersion !== fromKeyVersion) fail("CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH", { step: "identity-rotate-pin" });
  // Both documents are written once: refuse before either exists half-made.
  for (const name of [OWNER_FILES.pin, OWNER_FILES.rotation]) {
    if (await fileExists(join(directory, name))) fail("CUTOVER_RECEIPT_CONFLICT", { step: "identity-rotate-pin" });
  }
  const secret = await readSecretFromStream(stream);
  const { pin, rotation } = buildIdentityLinkRotation({ secret, sealedPin, fromKeyVersion, toKeyVersion, secretName,
    secretVersion, consumerRouteIds: IDENTITY_LINK_CONSUMER_ROUTE_IDS, computedAt: now().toISOString(),
    labels: PRODUCTION_IDENTITY_LINK_ROTATION_LABELS });
  const pinSha256 = await writePrivateFileOnce(join(directory, OWNER_FILES.pin), `${canonicalJson(pin)}\n`, 0o400);
  const rotationSha256 = await writePrivateFileOnce(join(directory, OWNER_FILES.rotation), `${canonicalJson(rotation)}\n`,
    0o400);
  return Object.freeze({ schema: IDENTITY_LINK_ROTATION_SCHEMA, step: "identity-rotate-pin",
    fromKeyVersion: rotation.from.keyVersion, toKeyVersion: rotation.to.keyVersion, secretVersion: rotation.to.secretVersion,
    pinSha256, rotationSha256 });
}

export async function writeIdentityPin({ ownerDirectory, stream, keyVersion, secretName, secretVersion,
  now = () => new Date(), forbiddenRoots = undefined }) {
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  const secret = await readSecretFromStream(stream);
  const pin = buildIdentityLinkPin({ secret, keyVersion, secretName, secretVersion, computedAt: now().toISOString() });
  const path = join(directory, OWNER_FILES.pin);
  const pinSha256 = await writePrivateFileOnce(path, `${canonicalJson(pin)}\n`, 0o400);
  return Object.freeze({ schema: IDENTITY_LINK_PIN_SCHEMA, step: "identity-pin", keyVersion: pin.keyVersion,
    secretVersion: pin.secretVersion, pinSha256 });
}

// ---------------------------------------------------------------------------
// Preflight: the import go/no-go (design section 5).

export async function runPreflight(context) {
  const result = await withSeal(context, async (sealed) => {
    const { seal } = sealed;
    const ingestion = sealed.database("ingestion");
    const ledger = sealed.database("deletion-ledger");
    const checks = {};
    // P1 seal, P2 fence binding.
    if (seal.manifest.expectedSourceCommit !== context.inputs.expectedSourceCommit) {
      fail("CUTOVER_SEAL_SOURCE_COMMIT_MISMATCH", { check: "P1" });
    }
    checks.P1 = Object.freeze({ sealId: seal.manifest.sealId, manifestSha256: seal.manifestSha256,
      sources: Object.freeze(CUTOVER_SOURCE_ROLES.map(role => seal.sources[role].sealedSha256)) });
    if (seal.manifest.fence?.fenceReceiptSha256 !== context.inputs.fenceReceiptSha256) {
      fail("CUTOVER_SEAL_FENCE_MISMATCH", { check: "P2" });
    }
    checks.P2 = Object.freeze({ fenceReceiptSha256: context.inputs.fenceReceiptSha256 });
    // P3 coverage, P4 correction runtime, P5 erasure quiescence.
    checks.P3 = evaluateSealedCoverage({ ingestion, "deletion-ledger": ledger }, { ownerFlags: context.inputs.ownerFlags });
    checks.P4 = correctionRuntimeCheck(ingestion);
    checks.P5 = erasureQuiescenceCheck(ingestion, ledger);
    // P6 the deletion-digest exclusion count.
    checks.P6 = (await deletionDigestCheck(context, sealed)).report;
    // P7 bootstrap, P8 identity pin (the sealed row, then the mount the
    // committed production desired state names), P9 controls.
    checks.P7 = bootstrapCheck(ingestion);
    const { pin, sha256: pinSha256 } = await readPin(context);
    const sealedPinRows = sealedRows(ingestion, "SELECT key_version, secret_fingerprint FROM identity_link_secret_configuration");
    const declared = await readRotation(context);
    const deployment = await readProductionDeployment(context.desiredStatePath);
    if (declared === null) {
      // P8: the pin is the sealed row, unchanged (no rotation without its document).
      const pinned = assertPinMatchesSealed(pin, sealedPinRows,
        { expectedKeyVersion: context.inputs.expectedIdentityKeyVersion });
      const mounted = assertPinMatchesMount(pin, deployment.identityLinkMount);
      checks.P8 = Object.freeze({ pinSha256, keyVersion: pinned.keyVersion, secretVersion: mounted.secretVersion,
        mountBound: true });
    } else {
      // P8-R (round 16): the labels are the origin's (readRotation tied the
      // inputs too), from == the sealed row, the pin == to, the mount, and
      // every identity-link consumer retired.
      const rotated = assertRotationMatchesSealed(declared.rotation, pin, sealedPinRows,
        PRODUCTION_IDENTITY_LINK_ROTATION_LABELS);
      const mounted = assertPinMatchesMount(pin, deployment.identityLinkMount);
      const consumersRetired = identityLinkConsumersCheck(context.portedRouteIds);
      checks.P8 = Object.freeze({ pinSha256, keyVersion: rotated.toKeyVersion, secretVersion: mounted.secretVersion,
        mountBound: true, rotation: Object.freeze({ rotationSha256: declared.rotationSha256,
          fromKeyVersion: rotated.fromKeyVersion, toKeyVersion: rotated.toKeyVersion, consumersRetired }) });
    }
    checks.P9 = controlsCheck(ingestion);
    // P10 target (open refuses a non-empty target unless this seal resumes).
    const handle = await openHandle(context);
    checks.P10 = Object.freeze({ contractId: handle.contractId, mode: handle.mode, ...await targetFacts(handle) });
    // P11 scheduler, P12 the OWN-4 export, P13 the pending-object guard, P14
    // nonces, P15 the admin history export (post-import's mapping refuses an
    // unbound one too, but only after every stage has imported).
    checks.P11 = await schedulerCheck(context, seal, deployment);
    checks.P12 = (await interimReadCheck(context, seal)).receipt;
    const guard = await checkPendingObjectTransferGuard(handle, { ownerFlags: context.inputs.ownerFlags
      .filter(flag => flag === OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING) });
    checks.P13 = Object.freeze({ guard: guard.guard });
    checks.P14 = Object.freeze({ unexpiredAtSeal: sparkleNonceCount(ingestion, Date.parse(seal.manifest.createdAt) / 1000) });
    checks.P15 = await checkAdminHistoryExportBinding({ seal, database: ingestion,
      adminHistoryExportPath: context.inputs.adminHistoryExport.path,
      adminHistoryExportSha256: context.inputs.adminHistoryExport.sha256 });
    // P16 the revision floor (REV-SEED): pinned, bound to this seal, and at or
    // above every frozen-read revision; the stage loads it.
    checks.P16 = (await revisionFloorCheck(context, seal)).receipt;
    return Object.freeze({
      schema: `${PRODUCTION_TRANSFER_SCHEMA}-preflight`,
      verdict: "GO",
      sealId: seal.manifest.sealId,
      contractId: context.inputs.contractId,
      inputsSha256: context.inputsSha256,
      dispositionPolicySha256: dispositionPolicySha256(),
      ownerFlags: context.inputs.ownerFlags,
      checks: Object.freeze(checks),
    });
  });
  const preflightSha256 = await writeReceiptOnce(context.path("preflight"), result);
  await journal(context, "preflight", "go", { preflightSha256 });
  const declared = await readRotation(context);
  return Object.freeze({ verdict: "GO", preflightSha256, runAuthorizationToken: authorizationToken("run",
    { sealId: context.inputs.sealId, contractId: context.inputs.contractId, inputsSha256: context.inputsSha256,
      preflightSha256 }),
  ...(declared === null ? {} : { identityRotationAuthorizationToken: identityRotationToken(context, preflightSha256, declared) }),
  checks: result.checks });
}

async function readPreflight(context) {
  if (!await fileExists(context.path("preflight"))) fail("CUTOVER_PREFLIGHT_MISSING");
  const { value, sha256 } = await readOwnerJson(context.path("preflight"), "CUTOVER_PREFLIGHT_MISSING");
  if (!record(value) || value.verdict !== "GO" || value.sealId !== context.inputs.sealId
      || value.inputsSha256 !== context.inputsSha256 || value.contractId !== context.inputs.contractId
      || value.dispositionPolicySha256 !== dispositionPolicySha256()) {
    fail("CUTOVER_PREFLIGHT_MISSING");
  }
  return { preflight: value, preflightSha256: sha256 };
}

// ---------------------------------------------------------------------------
// R2 stages.

function sourceDigest(sealed, item) {
  const present = sealedCatalog(sealed.database(item.role)).includes(item.table);
  if (!present) return null;
  return genericSealedDigest(sealed.database(item.role), item.table);
}

/** Write the complete receipt of every orchestrator disposition of `stage` (inside the caller's transaction). */
async function writeOrchestratorReceipts(client, handle, sealed, stage) {
  const written = [];
  for (const item of DISPOSITIONS.filter(entry => entry.writer === "orchestrator" && entry.stage === stage
      && entry.token !== "verified-equal")) {
    const digest = sourceDigest(sealed, item);
    if (digest === null) continue;
    if (item.rule === "empty" && digest.rows !== 0) {
      fail("CUTOVER_COVERAGE_RECEIPT_MISMATCH", { table: item.table, count: digest.rows });
    }
    await tableReceipt(client, handle, { stage, sourceRole: item.role, sourceTable: item.table, disposition: item.token,
      state: "complete", sourceRowCount: digest.rows, sourceSha256: digest.sha256 });
    written.push(Object.freeze({ role: item.role, table: item.table, rows: digest.rows, sha256: digest.sha256 }));
  }
  return written;
}

async function runWaiver(context, handle, sealed, entry) {
  assertWaiverAllowed(entry.stage, entry.reason);
  const receiptSha256 = stageWaiverSha256({ sealId: context.inputs.sealId, stage: entry.stage, reason: entry.reason });
  await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    for (const prerequisite of stagePrerequisites(entry.stage)) {
      await assertStageCompleteIn(client, handle, prerequisite);
    }
    await writeOrchestratorReceipts(client, handle, sealed, entry.stage);
    await stageReceipt(client, handle, { stage: entry.stage, state: "complete", rowCount: 0, byteCount: 0, receiptSha256 });
  });
  return Object.freeze({ stage: entry.stage, waived: entry.reason, receiptSha256 });
}

async function assertStageCompleteIn(client, handle, stage) {
  const { rows } = await client.query(`SELECT 1 FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_stage_receipts receipt
      JOIN ${TRANSFER_CONTROL_SCHEMA}.transfer_runs run ON run.run_id = receipt.run_id
     WHERE run.seal_manifest_sha256 = $1 AND run.contract_id = $2 AND run.state <> 'abandoned'
       AND receipt.stage = $3 AND receipt.state = 'complete'`, [handle.sealManifestSha256, handle.contractId, stage]);
  if (rows.length !== 1) fail("CUTOVER_STEP_ORDER_VIOLATION", { stage });
}

async function completeStages(handle) {
  return withTransferTransaction(handle, "primary", async client => {
    const { rows } = await client.query(`SELECT receipt.stage FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_stage_receipts receipt
        JOIN ${TRANSFER_CONTROL_SCHEMA}.transfer_runs run ON run.run_id = receipt.run_id
       WHERE run.seal_manifest_sha256 = $1 AND run.contract_id = $2 AND run.state <> 'abandoned'
         AND receipt.state = 'complete'`, [handle.sealManifestSha256, handle.contractId]);
    return new Set(rows.map(row => row.stage));
  }, { readOnly: true });
}

async function assertPrerequisites(handle, stage) {
  await withTransferTransaction(handle, "primary", async client => {
    for (const prerequisite of stagePrerequisites(stage)) await assertStageCompleteIn(client, handle, prerequisite);
  }, { readOnly: true });
}

async function runOwnerLifecycleVerify(context, handle, sealed) {
  const stage = "owner-lifecycle-verify";
  const revisions = await compareOwnerRevisions(handle, sealed.database("ingestion"));
  if (revisions.equal !== true || revisions.sourceIdMatches !== true) fail("CUTOVER_OWNER_REVISIONS_DIVERGED", { stage });
  const summary = { schema: `${PRODUCTION_TRANSFER_SCHEMA}-owner-lifecycle`, sealId: context.inputs.sealId,
    revisions: { sourceRows: revisions.sourceRows, sourceSha256: revisions.sourceSha256, targetRows: revisions.targetRows,
      targetSha256: revisions.targetSha256 } };
  await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    for (const prerequisite of stagePrerequisites(stage)) await assertStageCompleteIn(client, handle, prerequisite);
    await tableReceipt(client, handle, { stage, sourceRole: "ingestion", sourceTable: "storage_owner_revisions",
      disposition: "verified-equal", targetTable: "storage_owner_revisions", state: "complete",
      sourceRowCount: revisions.sourceRows, sourceSha256: revisions.sourceSha256, targetRowCount: revisions.targetRows,
      targetSha256: revisions.targetSha256 });
    summary.tables = await writeOrchestratorReceipts(client, handle, sealed, stage);
    await stageReceipt(client, handle, { stage, state: "complete", rowCount: revisions.sourceRows, byteCount: 0,
      receiptSha256: HASH(canonicalJson(summary)) });
  });
  return Object.freeze({ stage, ownerRevisions: revisions.sourceRows });
}

/**
 * The 'analytics-community-history' stage (REV-SEED, round 14): the per-day
 * revision floor, loaded once in one transaction with its stage receipt, so
 * markLive (which requires every stage complete) cannot precede it. The
 * receipt digests the floor's identity, not the load state, so a rerun after
 * a crash between the load and the receipt writes an equal receipt.
 */
async function runRevisionFloorStage(context, handle, sealed) {
  const stage = REVISION_FLOOR_STAGE;
  const { floor, receipt } = await revisionFloorCheck(context, sealed.seal);
  const summary = { schema: `${PRODUCTION_TRANSFER_SCHEMA}-revision-floor`, sealId: context.inputs.sealId,
    floor: receipt };
  const receiptSha256 = HASH(canonicalJson(summary));
  const loaded = await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    for (const prerequisite of stagePrerequisites(stage)) await assertStageCompleteIn(client, handle, prerequisite);
    const result = await loadRevisionFloorInTransaction({ client, schema: handle.primarySchema, floor });
    await stageReceipt(client, handle, { stage, state: "complete", rowCount: floor.dayCount, byteCount: 0, receiptSha256 });
    return result;
  });
  return Object.freeze({ stage, receiptSha256, floorSha256: floor.floorSha256, state: loaded.state });
}

async function runStage(context, handle, sealed, entry, rotation) {
  const base = { handle, sealManifestPath: context.inputs.sealManifestPath, ...context.runnerOptions };
  if (entry.kind === "waiver") return runWaiver(context, handle, sealed, entry);
  await assertPrerequisites(handle, entry.stage);
  if (entry.stage === "owner-lifecycle-verify") return runOwnerLifecycleVerify(context, handle, sealed);
  if (entry.stage === REVISION_FLOOR_STAGE) return runRevisionFloorStage(context, handle, sealed);
  if (entry.stage === IDENTITY_LINK_ROTATION_STAGE) return runIdentityLinkRotation(context, handle, rotation);
  let result;
  if (entry.stage === "identity-authority") {
    const { pin } = await readPin(context);
    // Under a rotation PT-3 asserts sealed == rotation.from (the new pin can
    // never equal the sealed row) and still copies the row verbatim; the
    // rotation itself is the next stage.
    result = await runIdentityAuthorityTransfer({ ...base, identityLinkPin: rotation === null
      ? { keyVersion: pin.keyVersion, secretFingerprint: pin.secretFingerprint }
      : { mode: "rotate", sealedPin: { keyVersion: rotation.rotation.from.keyVersion,
        secretFingerprint: rotation.rotation.from.secretFingerprint }, rotationSha256: rotation.rotationSha256 } });
  } else if (entry.stage === "legacy-contributions") {
    result = await runLegacyContributionsProduction(base);
  } else if (entry.stage === "pending-registrations") {
    result = await runPendingRegistrationsProduction({ ...base, ownerFlags: context.inputs.ownerFlags
      .filter(flag => flag === OWNER_FLAG_ACCEPT_ORPHAN_REGISTRATION_CLEARING) });
  } else if (Object.hasOwn(TELEMETRY_PRODUCTION_RUNNERS, entry.stage)) {
    result = await TELEMETRY_PRODUCTION_RUNNERS[entry.stage](base);
  } else {
    fail("CUTOVER_ARGUMENT_INVALID", { stage: entry.stage });
  }
  return Object.freeze({ stage: entry.stage, receiptSha256: typeof result?.receiptSha256 === "string" ? result.receiptSha256 : null });
}

// ---------------------------------------------------------------------------
// Round 16: the identity-link rotation stage and its continuity checks.

const PIN_INSTANT = `to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The target's singleton pin row and this run's rotation checkpoint, inside the caller's transaction. */
async function readIdentityLinkState(client, handle, { lock = "" } = {}) {
  const { rows } = await client.query(`SELECT key_version, secret_fingerprint, ${PIN_INSTANT} AS recorded_at
    FROM ${quote(handle.primarySchema)}.identity_link_secret_configuration WHERE singleton = 1 ${lock}`);
  const { rows: checkpoints } = await client.query(`SELECT checkpoint.state, checkpoint.row_count::text AS row_count,
      checkpoint.prefix_chain_sha256
    FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_checkpoints checkpoint
    JOIN ${TRANSFER_CONTROL_SCHEMA}.transfer_runs run ON run.run_id = checkpoint.run_id
   WHERE run.seal_manifest_sha256 = $1 AND run.contract_id = $2 AND run.state <> 'abandoned'
     AND checkpoint.stage = $3 AND checkpoint.checkpoint_name = $4`,
  [handle.sealManifestSha256, handle.contractId, IDENTITY_LINK_ROTATION_STAGE, IDENTITY_LINK_ROTATION_CHECKPOINT]);
  return { row: rows.length === 1 ? rows[0] : null, rows: rows.length, checkpoint: checkpoints[0] ?? null };
}

const pinEquals = (row, pin) => row !== null && row.key_version === pin.keyVersion
  && row.secret_fingerprint === pin.secretFingerprint;

/**
 * The 'identity-link-rotation' stage, right after PT-3. Without a declared
 * rotation it records a complete no-op receipt. With one, in one transfer
 * transaction: the singleton pin row FOR UPDATE; if it is the rotation's
 * `from`, it moves to `to` (recorded_at from the database clock) and the
 * stage writes its checkpoint (prefix = the rotation document's sha256) and
 * its receipt; if it is already `to` with this rotation's complete
 * checkpoint, nothing is written (replay-safe); anything else refuses
 * CUTOVER_IDENTITY_ROTATION_STATE_INVALID. PT-3's table receipt for the
 * pin table is untouched, so coverage still sees exactly one table receipt.
 */
async function runIdentityLinkRotation(context, handle, rotation) {
  const stage = IDENTITY_LINK_ROTATION_STAGE;
  if (rotation === null) {
    const receiptSha256 = HASH(canonicalJson({ schema: `${PRODUCTION_TRANSFER_SCHEMA}-identity-link-rotation`,
      sealId: context.inputs.sealId, stage, mode: "unrotated" }));
    await withTransferTransaction(handle, "primary", async client => {
      await requireImportingRun(client, handle);
      for (const prerequisite of stagePrerequisites(stage)) await assertStageCompleteIn(client, handle, prerequisite);
      await stageReceipt(client, handle, { stage, state: "complete", rowCount: 0, byteCount: 0, receiptSha256 });
    });
    return Object.freeze({ stage, rotated: false, receiptSha256 });
  }
  const { rotation: document, rotationSha256, rotationTokenSha256 } = rotation;
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    for (const prerequisite of stagePrerequisites(stage)) await assertStageCompleteIn(client, handle, prerequisite);
    const { row, rows, checkpoint } = await readIdentityLinkState(client, handle, { lock: "FOR UPDATE" });
    if (rows !== 1) fail("CUTOVER_IDENTITY_ROTATION_STATE_INVALID", { stage });
    if (pinEquals(row, document.from) && checkpoint === null) {
      const updated = await client.query(`UPDATE ${quote(handle.primarySchema)}.identity_link_secret_configuration
          SET key_version = $1, secret_fingerprint = $2, recorded_at = date_trunc('milliseconds', clock_timestamp())
        WHERE singleton = 1 AND key_version = $3 AND secret_fingerprint = $4`,
      [document.to.keyVersion, document.to.secretFingerprint, document.from.keyVersion, document.from.secretFingerprint]);
      if (updated.rowCount !== 1) fail("CUTOVER_IDENTITY_ROTATION_STATE_INVALID", { stage });
      // Synthetic-kill hook INSIDE the transaction: a throw here rolls the
      // UPDATE back with the receipt never written.
      if (context.onStep !== null) await context.onStep(`${stage}:updated`);
      const body = { schema: `${PRODUCTION_TRANSFER_SCHEMA}-identity-link-rotation`, stage, sealId: context.inputs.sealId,
        fromKeyVersion: document.from.keyVersion, toKeyVersion: document.to.keyVersion,
        toSecretVersion: document.to.secretVersion, rotationSha256, rotationTokenSha256,
        previousRecordedAt: row.recorded_at, state: "complete" };
      const receiptSha256 = HASH(canonicalJson(body));
      await recordCheckpoint(client, handle, { stage, name: IDENTITY_LINK_ROTATION_CHECKPOINT, state: "complete",
        rowCount: 1, prefixChainSha256: rotationSha256 });
      await stageReceipt(client, handle, { stage, state: "complete", rowCount: 1, byteCount: 0, receiptSha256 });
      return Object.freeze({ stage, rotated: true, replayed: false, receiptSha256 });
    }
    if (pinEquals(row, document.to) && checkpoint?.state === "complete" && checkpoint.prefix_chain_sha256 === rotationSha256) {
      await assertStageCompleteIn(client, handle, stage);
      return Object.freeze({ stage, rotated: true, replayed: true });
    }
    return fail("CUTOVER_IDENTITY_ROTATION_STATE_INVALID", { stage });
  });
}

/**
 * Identity-link continuity, asserted by R3 post-import, the flip gate and
 * the post-live check (inside the caller's transaction): without a rotation
 * the target pin is the configured pin (the sealed row); with one it is the
 * rotation's `to` AND this run holds the rotation's complete checkpoint and
 * a complete 'identity-link-rotation' stage receipt. Never skipped.
 */
async function assertIdentityLinkContinuity(client, handle, { pin, rotation }) {
  const { row, rows, checkpoint } = await readIdentityLinkState(client, handle);
  const { rows: stageRows } = await client.query(`SELECT 1 FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_stage_receipts receipt
      JOIN ${TRANSFER_CONTROL_SCHEMA}.transfer_runs run ON run.run_id = receipt.run_id
     WHERE run.seal_manifest_sha256 = $1 AND run.contract_id = $2 AND run.state <> 'abandoned'
       AND receipt.stage = $3 AND receipt.state = 'complete'`,
  [handle.sealManifestSha256, handle.contractId, IDENTITY_LINK_ROTATION_STAGE]);
  if (rows !== 1 || stageRows.length !== 1) fail("CUTOVER_IDENTITY_ROTATION_STATE_INVALID", { check: "identity-link" });
  if (rotation === null) {
    if (!pinEquals(row, pin) || checkpoint !== null) fail("CUTOVER_IDENTITY_ROTATION_STATE_INVALID", { check: "identity-link" });
    return Object.freeze({ mode: "pinned", keyVersion: pin.keyVersion });
  }
  if (!pinEquals(row, rotation.rotation.to) || checkpoint?.state !== "complete" || checkpoint.row_count !== "1"
      || checkpoint.prefix_chain_sha256 !== rotation.rotationSha256) {
    fail("CUTOVER_IDENTITY_ROTATION_STATE_INVALID", { check: "identity-link" });
  }
  return Object.freeze({ mode: "rotated", keyVersion: rotation.rotation.to.keyVersion,
    rotationSha256: rotation.rotationSha256 });
}

async function identityLinkFacts(context) {
  const { pin } = await readPin(context);
  return { pin, rotation: await readRotation(context) };
}

// ---------------------------------------------------------------------------
// R3 post-import.

async function restartTypedIdentities(handle) {
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    await client.query("SELECT typed_telemetry_restart_identities()");
    let checked = 0;
    for (const table of TYPED_IDENTITY_TABLES) {
      const relation = `${quote(handle.primarySchema)}.${quote(table)}`;
      const { rows } = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS sequence`, [relation]);
      if (typeof rows[0]?.sequence !== "string") fail("CUTOVER_TYPED_IDENTITY_HEADROOM_INVALID", { table });
      const { rows: facts } = await client.query(`SELECT (SELECT COALESCE(max(id), 0) FROM ${relation})::text AS maximum,
          last_value::text AS last_value, is_called FROM ${rows[0].sequence}`);
      const maximum = BigInt(facts[0].maximum);
      const next = facts[0].is_called === true ? BigInt(facts[0].last_value) + 1n : BigInt(facts[0].last_value);
      if (next <= maximum) fail("CUTOVER_TYPED_IDENTITY_HEADROOM_INVALID", { table });
      checked += 1;
    }
    return checked;
  });
}

async function postImportInvariants(context, handle, sealed, digests) {
  const schema = handle.primarySchema;
  const ingestion = sealed.database("ingestion");
  const sealedRegistrations = sealedCount(ingestion, "SELECT count(*) AS n FROM pending_quarantine_objects");
  const identity = await identityLinkFacts(context);
  const facts = await withTransferTransaction(handle, "primary", async client => {
    await assertCollectionControlsDegradedForImport(client, handle);
    const identityLink = await assertIdentityLinkContinuity(client, handle, identity);
    const { rows: bootstrap } = await client.query(`SELECT policy_version, participant_cursor, source_day_cursor, completed
      FROM ${quote(schema)}.community_public_source_bootstrap`);
    if (bootstrap.length !== 1 || bootstrap[0].policy_version !== PUBLIC_SOURCE_BOOTSTRAP_POLICY
        || bootstrap[0].completed !== 1 || bootstrap[0].participant_cursor !== "" || bootstrap[0].source_day_cursor !== "") {
      fail("CUTOVER_BOOTSTRAP_TARGET_INVALID");
    }
    const { rows: quarantineTable } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present",
      [`${quote(schema)}.pending_quarantine_objects`]);
    const quarantine = quarantineTable[0].present === true ? Number((await client.query(
      `SELECT count(*)::int AS n FROM ${quote(schema)}.pending_quarantine_objects`)).rows[0].n) : 0;
    const { rows: pending } = await client.query(`SELECT count(*)::int AS mapped, count(DISTINCT object_key)::int AS keys
      FROM ${quote(schema)}.pending_objects`);
    if (quarantine !== 0 || pending[0].mapped !== sealedRegistrations || pending[0].keys !== sealedRegistrations) {
      fail("CUTOVER_PENDING_OBJECT_CONFLICT");
    }
    // Variant B step 4: the do-not-restore list re-checked on the PostgreSQL side.
    let matches = 0;
    let participants = 0;
    let after = "";
    for (;;) {
      const { rows } = await client.query(`SELECT id FROM ${quote(schema)}.participants WHERE id > $1
        ORDER BY id COLLATE "C" LIMIT 1000`, [after]);
      for (const row of rows) {
        participants += 1;
        if (digests.has(participantDeletionDigest(row.id))) matches += 1;
      }
      if (rows.length < 1000) break;
      after = rows.at(-1).id;
    }
    if (matches !== 0) fail("CUTOVER_ERASED_PARTICIPANT_PRESENT", { count: matches });
    const seeds = new Map(SEEDED_SINGLETONS.map(entry => [entry.table, entry.seedRows]));
    let atSeed = 0;
    for (const table of RUNTIME_RESET_TABLES) {
      const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`${quote(schema)}.${quote(table)}`]);
      if (rows[0].present !== true) continue;
      const limit = seeds.get(table) ?? 0;
      const { rows: counted } = await client.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${quote(schema)}.${quote(table)}
        LIMIT ${limit + 1}) sample`);
      if (counted[0].n > limit) fail("CUTOVER_RUNTIME_RESET_NOT_AT_SEED", { table });
      atSeed += 1;
    }
    return { participants, pendingObjects: pending[0].mapped, runtimeResetAtSeed: atSeed, identityLink };
  }, { readOnly: true });
  const owners = await comparePublicSourceOwners(handle, ingestion);
  if (owners.equal !== true) fail("CUTOVER_PUBLIC_SOURCE_OWNERS_DIVERGED");
  return Object.freeze({ ...facts, doNotRestoreMatches: 0, publicSourceOwnersEqual: true });
}

/**
 * Coverage finalize: the post-import dispositions are receipted, then every
 * sealed table must hold exactly one complete receipt with exactly its token
 * and stage, and no receipt may name a table outside the dispositions.
 */
async function finalizeCoverage(handle, sealed) {
  return withTransferTransaction(handle, "primary", async client => {
    const run = await requireImportingRun(client, handle);
    await writeOrchestratorReceipts(client, handle, sealed, "post-import");
    const { rows } = await client.query(`SELECT source_role, source_table, stage, disposition, state,
        source_row_count::text AS source_row_count, source_sha256, target_row_count::text AS target_row_count, target_sha256
      FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_table_receipts WHERE run_id = $1
      ORDER BY source_role, source_table`, [run.runId]);
    const byKey = new Map(rows.map(row => [`${row.source_role}:${row.source_table}`, row]));
    for (const row of rows) {
      if (!DISPOSITION_INDEX.has(`${row.source_role}:${row.source_table}`)) {
        fail("CUTOVER_COVERAGE_RECEIPT_UNEXPECTED", { table: row.source_table });
      }
    }
    let covered = 0;
    for (const item of DISPOSITIONS) {
      if (!sealedCatalog(sealed.database(item.role)).includes(item.table)) continue;
      const row = byKey.get(`${item.role}:${item.table}`);
      if (row === undefined || row.state !== "complete") fail("CUTOVER_COVERAGE_RECEIPT_MISSING", { table: item.table, stage: item.stage });
      if (row.stage !== item.stage || row.disposition !== item.token) {
        fail("CUTOVER_COVERAGE_RECEIPT_MISMATCH", { table: item.table, stage: item.stage });
      }
      covered += 1;
    }
    const coverageSha256 = HASH(canonicalJson(rows.map(row => [row.source_role, row.source_table, row.stage, row.disposition,
      row.source_row_count, row.source_sha256, row.target_row_count, row.target_sha256])));
    return Object.freeze({ tables: covered, coverageSha256 });
  });
}

async function loadFrozenRead(context, handle, seal) {
  const { prepared } = await interimReadCheck(context, seal);
  const receipt = await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    return loadInterimPublicReadInTransaction({ client, schema: handle.primarySchema, prepared });
  });
  if (receipt.state !== "loaded" && receipt.state !== "already-loaded") fail("CUTOVER_INTERIM_READ_NOT_LOADED");
  return Object.freeze({ state: receipt.state, payloadSha256: receipt.payloadSha256, evidenceDate: receipt.evidenceDate });
}

async function cleanupControlSchema(handle) {
  return withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    const scrubbed = await scrubCheckpointCursors(client, handle, STAGING_SCRUB_REGISTRY);
    const dropped = await dropTransferStagingRelations(client, handle, STAGING_DROP_REGISTRY);
    await assertNoTransferUserOwnership(client, handle);
    return Object.freeze({ scrubbedRelations: scrubbed.length,
      dropped: Object.freeze(dropped.map(item => Object.freeze({ relation: item.relation, rowsSha256: item.rowsSha256 }))) });
  });
}

async function runPostImport(context, handle, sealed, preflightSha256) {
  const stage = "post-import";
  await assertPrerequisites(handle, stage);
  await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    await stageReceipt(client, handle, { stage, state: "started" });
  });
  await step(context, "post-import:started");
  const typedIdentities = await restartTypedIdentities(handle);
  await step(context, "post-import:tl1", { count: typedIdentities });
  const history = await runOperationalHistoryProduction({ handle, sealManifestPath: context.inputs.sealManifestPath,
    adminHistoryExportPath: context.inputs.adminHistoryExport.path,
    adminHistoryExportSha256: context.inputs.adminHistoryExport.sha256, ...context.runnerOptions });
  await step(context, "post-import:operational-history");
  const deletion = await deletionDigestCheck(context, sealed);
  const invariants = await postImportInvariants(context, handle, sealed, deletion.digests);
  await step(context, "post-import:invariants");
  const coverage = await finalizeCoverage(handle, sealed);
  await step(context, "post-import:coverage", { count: coverage.tables });
  const parity = await withTransferTransaction(handle, "primary", client => runParitySample({
    database: sealed.database("ingestion"), client, schema: handle.primarySchema, sealId: context.inputs.sealId,
  }), { readOnly: true });
  await step(context, "post-import:parity", { count: parity.sampledOwners });
  const frozen = await loadFrozenRead(context, handle, sealed.seal);
  await step(context, "post-import:interim-read", { state: frozen.state });
  const cleanup = await cleanupControlSchema(handle);
  await step(context, "post-import:cleanup");
  const body = {
    schema: `${PRODUCTION_TRANSFER_SCHEMA}-post-import`,
    sealId: context.inputs.sealId,
    contractId: context.inputs.contractId,
    dispositionPolicySha256: dispositionPolicySha256(),
    preflightSha256,
    deletionDigests: deletion.report,
    typedIdentitiesRestarted: typedIdentities,
    operationalHistorySha256: history.receiptSha256,
    invariants,
    coverage,
    parity,
    interimRead: { payloadSha256: frozen.payloadSha256, evidenceDate: frozen.evidenceDate },
    cleanup,
  };
  const receiptSha256 = HASH(canonicalJson(body));
  // The owner receipt is written BEFORE the stage commits: a crash between
  // the two reruns post-import, which recomputes the same body and finds the
  // file equal. Written after, a crash would leave a complete stage with no
  // post-import.json, and `report` would refuse for good.
  const postImportSha256 = await writeReceiptOnce(context.path("postImport"), { ...body, receiptSha256 });
  await step(context, "post-import:receipt", { postImportSha256 });
  await withTransferTransaction(handle, "primary", async client => {
    await requireImportingRun(client, handle);
    await stageReceipt(client, handle, { stage, state: "complete", rowCount: coverage.tables, byteCount: 0, receiptSha256 });
  });
  await step(context, "post-import", { postImportSha256 });
  return Object.freeze({ receiptSha256, postImportSha256, interimRead: frozen.state, parity: parity.mismatches });
}

/**
 * The owner receipt of a complete post-import stage, bound to the database:
 * post-import.json must exist, name this seal, carry the receipt digest the
 * stage committed, and that digest must be the digest of its own body. A rerun
 * that skips the complete stage requires it, and so does the flip gate, which
 * ties the frozen read it reads back to the export post-import loaded.
 */
async function readBoundPostImport(context, handle) {
  const committed = await withTransferTransaction(handle, "primary", async client => {
    const { rows } = await client.query(`SELECT receipt.receipt_sha256 FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_stage_receipts receipt
        JOIN ${TRANSFER_CONTROL_SCHEMA}.transfer_runs run ON run.run_id = receipt.run_id
       WHERE run.seal_manifest_sha256 = $1 AND run.contract_id = $2 AND run.state <> 'abandoned'
         AND receipt.stage = 'post-import' AND receipt.state = 'complete'`, [handle.sealManifestSha256, handle.contractId]);
    return rows.length === 1 ? rows[0].receipt_sha256 : null;
  }, { readOnly: true });
  if (!await fileExists(context.path("postImport"))) fail("CUTOVER_RECEIPT_CONFLICT", { step: "post-import" });
  const { value, sha256 } = await readOwnerJson(context.path("postImport"), "CUTOVER_RECEIPT_CONFLICT");
  if (committed === null || !record(value) || value.receiptSha256 !== committed || value.sealId !== context.inputs.sealId) {
    fail("CUTOVER_RECEIPT_CONFLICT", { step: "post-import" });
  }
  const { receiptSha256, ...body } = value;
  if (HASH(canonicalJson(body)) !== receiptSha256) fail("CUTOVER_RECEIPT_CONFLICT", { step: "post-import" });
  return Object.freeze({ postImport: value, postImportSha256: sha256 });
}

/**
 * At import start, the preflight facts that can go stale are proven again:
 * preflight.json carries no clock, so a GO taken hours earlier must not
 * authorize an import after a trigger resumed or a membership changed.
 * P11 (the scheduler probe at the inputs' path, under 6 h old now) and P10's
 * transfer-login memberships, with preflight's codes.
 */
async function recheckImportPreconditions(context, handle, seal) {
  const deployment = await readProductionDeployment(context.desiredStatePath);
  await schedulerCheck(context, seal, deployment);
  await withTransferTransaction(handle, "primary", client => transferLoginCheck(client, handle), { readOnly: true });
}

// ---------------------------------------------------------------------------
// run: R1 to R4.

export async function runImport(context, { execute = false, confirm = undefined, confirmIdentityRotation = undefined } = {}) {
  const { preflight, preflightSha256 } = await readPreflight(context);
  const token = authorizationToken("run", { sealId: context.inputs.sealId, contractId: context.inputs.contractId,
    inputsSha256: context.inputsSha256, preflightSha256 });
  // Round 16: a declared rotation needs its own token, bound to the
  // preflight that checked it (P8-R) and to the rotation document.
  const declared = await readRotation(context);
  if (declared !== null && preflight.checks?.P8?.rotation?.rotationSha256 !== declared.rotationSha256) {
    fail("CUTOVER_PREFLIGHT_MISSING");
  }
  const rotationToken = declared === null ? null : identityRotationToken(context, preflightSha256, declared);
  const preview = await openHandle(context);
  assertStepOrder("run", { runState: preview.openedRunState, preflight: true });
  if (!authorize("run", token, { execute, confirm })) {
    return Object.freeze({ mode: "dry-run", step: "run", authorizationToken: token,
      ...(rotationToken === null ? {} : { identityRotationAuthorizationToken: rotationToken }),
      resumed: preview.resumed, openedRunState: preview.openedRunState,
      plan: Object.freeze(STAGE_PLAN.map(entry => entry.stage)) });
  }
  // A run token alone never rotates; a rotation token without a declared rotation is refused too.
  if (rotationToken === null ? confirmIdentityRotation !== undefined
    : typeof confirmIdentityRotation !== "string" || confirmIdentityRotation !== rotationToken) {
    fail("CUTOVER_AUTHORIZATION_MISMATCH", { step: IDENTITY_ROTATION_AUTHORIZATION_STEP });
  }
  const rotation = declared === null ? null
    : Object.freeze({ ...declared, rotationTokenSha256: HASH(rotationToken) });
  return withOrchestratorLocks(context, preview.primarySchema, () => withSeal(context, async (sealed) => {
    let handle = await openHandle(context);
    assertStepOrder("run", { runState: handle.openedRunState, preflight: true });
    if (handle.openedRunState !== "verified") await recheckImportPreconditions(context, handle, sealed.seal);
    if (!handle.resumed) {
      await beginRun(handle, { sealedAt: sealed.seal.manifest.createdAt });
      await step(context, "begin");
    }
    let state = (await readRunFacts(handle)).state;
    if (state === "preflight") {
      await advanceRun(handle, "importing");
      state = "importing";
      await step(context, "importing");
    }
    const ran = [];
    if (state === "importing") {
      let complete = await completeStages(handle);
      for (const entry of STAGE_PLAN.filter(item => item.stage !== "post-import")) {
        if (complete.has(entry.stage)) continue;
        // A fresh handle per stage, as a resumed operator run would have.
        handle = await openHandle(context);
        const result = await runStage(context, handle, sealed, entry, rotation);
        ran.push(result.stage);
        await step(context, `stage:${entry.stage}`);
        complete = await completeStages(handle);
      }
      if (!complete.has("post-import")) await runPostImport(context, handle, sealed, preflightSha256);
      else await readBoundPostImport(context, handle);
      await advanceRun(handle, "verifying");
      state = "verifying";
      await step(context, "verifying");
    }
    if (state === "verifying") {
      await advanceRun(handle, "verified");
      state = "verified";
      await step(context, "verified");
    }
    const facts = await readRunFacts(handle);
    return Object.freeze({ mode: "executed", step: "run", runState: facts.state, stagesRun: Object.freeze(ran) });
  }));
}

// ---------------------------------------------------------------------------
// F1 to F5: flip evidence, release, flip gate, mark live.

/**
 * Validate a PT-2 verify-unchanged flip evidence file against the seal:
 * schema, seal id, inventory and fence digests, and per source the bookmark,
 * schema and aggregate digests and the sealed file digest. `after` is the
 * instant its verifiedAt must follow (CUTOVER_FLIP_EVIDENCE_STALE).
 */
export async function validateFlipEvidence(path, seal, { afterMs }) {
  const { value, sha256 } = await readOwnerJson(absolutePath(path, "CUTOVER_FLIP_EVIDENCE_INVALID"), "CUTOVER_FLIP_EVIDENCE_INVALID");
  exactKeys(value, ["schema", "sealId", "inventorySha256", "fenceReceiptSha256", "verifiedAt", "sources"],
    "CUTOVER_FLIP_EVIDENCE_INVALID");
  const manifest = seal.manifest;
  if (value.schema !== CUTOVER_FLIP_EVIDENCE_SCHEMA || value.sealId !== manifest.sealId
      || value.inventorySha256 !== manifest.inventorySha256 || value.fenceReceiptSha256 !== manifest.fence?.fenceReceiptSha256
      || !Array.isArray(value.sources) || value.sources.length !== CUTOVER_SOURCE_ROLES.length) {
    fail("CUTOVER_FLIP_EVIDENCE_INVALID");
  }
  value.sources.forEach((source, index) => {
    const role = CUTOVER_SOURCE_ROLES[index];
    const sealed = manifest.sources[index];
    exactKeys(source, ["role", "databaseIdSha256", "bookmark", "schemaSha256", "aggregatesSha256", "sealedSha256"],
      "CUTOVER_FLIP_EVIDENCE_INVALID");
    if (source.role !== role || sealed.role !== role || source.databaseIdSha256 !== sealed.databaseIdSha256
        || source.bookmark !== sealed.bookmark || source.schemaSha256 !== sealed.schemaSha256
        || source.aggregatesSha256 !== sealed.aggregatesSha256 || source.sealedSha256 !== sealed.sealedSha256) {
      fail("CUTOVER_FLIP_EVIDENCE_INVALID", { role });
    }
  });
  const verifiedMs = instantMs(value.verifiedAt);
  if (verifiedMs === null) fail("CUTOVER_FLIP_EVIDENCE_INVALID");
  if (!Number.isFinite(afterMs) || verifiedMs <= afterMs) fail("CUTOVER_FLIP_EVIDENCE_STALE");
  return Object.freeze({ sha256, verifiedAt: value.verifiedAt });
}

async function finalizeFacts(context) {
  const handle = await openHandle(context);
  const run = await readRunFacts(handle);
  return {
    handle,
    run,
    released: await fileExists(context.path("release")),
    flipGate: await fileExists(context.path("flipGate")),
  };
}

/**
 * The release instant: the database clock read in its own transaction after
 * the restore committed, rounded UP to the millisecond, so any evidence whose
 * verifiedAt is later was taken after the sealed controls were released.
 */
async function databaseInstantAfterCommit(handle) {
  return withTransferTransaction(handle, "primary", async client => {
    const { rows } = await client.query(`SELECT to_char(date_trunc('milliseconds', clock_timestamp() + interval '999 microseconds')
      AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
    if (instantMs(rows[0]?.at) === null) fail("CUTOVER_STEP_ORDER_VIOLATION", { step: "release-controls" });
    return rows[0].at;
  }, { readOnly: true });
}

export async function releaseControls(context, { flipEvidencePath, execute = false, confirm = undefined } = {}) {
  const seal = await readCutoverSeal({ manifestPath: context.inputs.sealManifestPath, expectedSealId: context.inputs.sealId });
  const { handle, run, released, flipGate } = await finalizeFacts(context);
  assertStepOrder("release-controls", { runState: run?.state ?? null, released, flipGate });
  const evidence = await validateFlipEvidence(flipEvidencePath, seal, { afterMs: Date.parse(run.verifiedAt) });
  // A rerun must name the same flip-1 evidence; it then restores the same
  // values again and keeps the first release instant, so the receipt is equal.
  const prior = released ? (await readRelease(context, run)).release : null;
  if (prior !== null && prior.flipEvidenceSha256 !== evidence.sha256) fail("CUTOVER_RECEIPT_CONFLICT", { step: "release-controls" });
  const token = authorizationToken("release-controls", { sealId: context.inputs.sealId, contractId: context.inputs.contractId,
    inputsSha256: context.inputsSha256, runId: run.runId, flipEvidenceSha256: evidence.sha256 });
  if (!authorize("release-controls", token, { execute, confirm })) {
    return Object.freeze({ mode: "dry-run", step: "release-controls", authorizationToken: token, flipEvidenceSha256: evidence.sha256 });
  }
  return withOrchestratorLocks(context, handle.primarySchema, async () => {
    const restored = await withTransferTransaction(handle, "primary", client => restoreSealedCollectionControls(client, handle));
    const releasedAt = prior?.releasedAt ?? await databaseInstantAfterCommit(handle);
    const body = { schema: `${PRODUCTION_TRANSFER_SCHEMA}-release-controls`, sealId: context.inputs.sealId, runId: run.runId,
      flipEvidenceSha256: evidence.sha256, flipEvidenceVerifiedAt: evidence.verifiedAt, releasedAt,
      sealedRowSha256: restored.sealedRowSha256, revision: restored.revision };
    const releaseSha256 = await writeReceiptOnce(context.path("release"), body);
    await step(context, "release-controls", { releaseSha256 });
    return Object.freeze({ mode: "executed", step: "release-controls", releaseSha256, sealedRowSha256: restored.sealedRowSha256,
      releasedAt });
  });
}

async function readRelease(context, run) {
  const { value, sha256 } = await readOwnerJson(context.path("release"), "CUTOVER_STEP_ORDER_VIOLATION");
  if (!record(value) || value.sealId !== context.inputs.sealId || value.runId !== run.runId
      || instantMs(value.releasedAt) === null || instantMs(value.flipEvidenceVerifiedAt) === null
      || typeof value.flipEvidenceSha256 !== "string" || !SHA256.test(value.flipEvidenceSha256)) {
    fail("CUTOVER_STEP_ORDER_VIOLATION", { step: "release-controls" });
  }
  return { release: value, releaseSha256: sha256 };
}

async function flipGateBody(context, handle, run, flipEvidencePath) {
  const seal = await readCutoverSeal({ manifestPath: context.inputs.sealManifestPath, expectedSealId: context.inputs.sealId });
  const { release, releaseSha256 } = await readRelease(context, run);
  // E2 must be fresh evidence taken after the release (F2): later than the
  // recorded release instant (and so than E1), and never E1 again.
  const evidence = await validateFlipEvidence(flipEvidencePath, seal,
    { afterMs: Math.max(instantMs(release.releasedAt), instantMs(release.flipEvidenceVerifiedAt)) });
  if (evidence.sha256 === release.flipEvidenceSha256) fail("CUTOVER_FLIP_EVIDENCE_STALE");
  // The frozen read must be the export post-import loaded (post-import.json,
  // bound to the committed stage receipt), not merely some row with id = 1.
  const { postImport, postImportSha256 } = await readBoundPostImport(context, handle);
  const loadedPayloadSha256 = record(postImport.interimRead) ? postImport.interimRead.payloadSha256 : null;
  if (typeof loadedPayloadSha256 !== "string" || !SHA256.test(loadedPayloadSha256)) fail("CUTOVER_INTERIM_READ_NOT_LOADED");
  const identity = await identityLinkFacts(context);
  const facts = await withTransferTransaction(handle, "primary", async client => {
    const identityLink = await assertIdentityLinkContinuity(client, handle, identity);
    // The staging-drop readback: PT-1's dropped-relation receipts cover the
    // registry exactly and the control schema holds only its allowlist.
    const { rows: dropped } = await client.query(`SELECT relation_name FROM ${TRANSFER_CONTROL_SCHEMA}.transfer_dropped_relations
      WHERE run_id = $1 ORDER BY relation_name`, [run.runId]);
    const expected = STAGING_DROP_REGISTRY.map(entry => entry.table).sort();
    if (JSON.stringify(dropped.map(row => row.relation_name)) !== JSON.stringify(expected)) {
      fail("CUTOVER_STEP_ORDER_VIOLATION", { step: "flip-gate", check: "staging-drop" });
    }
    const relations = await assertControlSchemaAllowlist(client);
    const { rows: frozen } = await client.query(`SELECT payload_sha256 FROM ${quote(handle.primarySchema)}.${INTERIM_PUBLIC_READ_TABLE}
      WHERE id = 1`);
    if (frozen.length !== 1 || frozen[0].payload_sha256 !== loadedPayloadSha256) fail("CUTOVER_INTERIM_READ_NOT_LOADED");
    const ready = await assertFlipReady(client, handle, { flipEvidenceSha256: evidence.sha256,
      allowedRoleMembers: [...context.inputs.allowedRoleMembers] });
    return { controlRelations: relations.length, frozenPayloadSha256: frozen[0].payload_sha256, ready, identityLink };
  }, { readOnly: true });
  const nonces = await withSeal(context, async sealed => sparkleNonceCount(sealed.database("ingestion"),
    context.now().getTime() / 1000));
  if (nonces !== 0) fail("CUTOVER_SPARKLE_NONCES_UNEXPIRED", { count: nonces });
  return {
    schema: `${PRODUCTION_TRANSFER_SCHEMA}-flip-gate`,
    sealId: context.inputs.sealId,
    contractId: context.inputs.contractId,
    runId: run.runId,
    postImportSha256,
    releaseSha256,
    flipEvidence1Sha256: release.flipEvidenceSha256,
    flipEvidence2Sha256: evidence.sha256,
    stagingDropped: STAGING_DROP_REGISTRY.length,
    controlRelations: facts.controlRelations,
    interimReadPayloadSha256: facts.frozenPayloadSha256,
    ready: facts.ready.ready,
    waivedRoleMembers: facts.ready.waivedRoleMembers,
    sparkleUnexpired: 0,
    identityLink: facts.identityLink,
  };
}

export async function flipGate(context, { flipEvidencePath } = {}) {
  const { handle, run, released, flipGate: gated } = await finalizeFacts(context);
  assertStepOrder("flip-gate", { runState: run?.state ?? null, released, flipGate: gated });
  const body = await flipGateBody(context, handle, run, flipEvidencePath);
  const flipGateSha256 = await writeReceiptOnce(context.path("flipGate"), body);
  await journal(context, "flip-gate", "ready", { flipGateSha256 });
  return Object.freeze({ step: "flip-gate", ready: true, flipGateSha256, flipEvidenceSha256: body.flipEvidence2Sha256,
    markLiveAuthorizationToken: authorizationToken("mark-live", { sealId: context.inputs.sealId,
      contractId: context.inputs.contractId, inputsSha256: context.inputsSha256, flipGateSha256,
      flipEvidenceSha256: body.flipEvidence2Sha256 }) });
}

export async function markLiveStep(context, { flipEvidenceSha256, execute = false, confirm = undefined } = {}) {
  sha(flipEvidenceSha256, "CUTOVER_FLIP_EVIDENCE_INVALID");
  const { handle, run, released, flipGate: gated } = await finalizeFacts(context);
  assertStepOrder("mark-live", { runState: run?.state ?? null, released, flipGate: gated });
  const { value: gate, sha256: flipGateSha256 } = await readOwnerJson(context.path("flipGate"), "CUTOVER_STEP_ORDER_VIOLATION");
  if (!record(gate) || gate.runId !== run.runId || gate.sealId !== context.inputs.sealId || gate.ready !== true
      || gate.flipEvidence2Sha256 !== flipEvidenceSha256) {
    fail("CUTOVER_FLIP_EVIDENCE_INVALID");
  }
  const token = authorizationToken("mark-live", { sealId: context.inputs.sealId, contractId: context.inputs.contractId,
    inputsSha256: context.inputsSha256, flipGateSha256, flipEvidenceSha256 });
  if (!authorize("mark-live", token, { execute, confirm })) {
    return Object.freeze({ mode: "dry-run", step: "mark-live", authorizationToken: token, pointOfNoReturn: true });
  }
  return withOrchestratorLocks(context, handle.primarySchema, async () => {
    if (run.state === "verified") {
      // Re-prove the gate's facts in the same order immediately before live.
      const fresh = await withTransferTransaction(handle, "primary", async client => {
        const { rows } = await client.query(`SELECT payload_sha256 FROM ${quote(handle.primarySchema)}.${INTERIM_PUBLIC_READ_TABLE}
          WHERE id = 1`);
        return rows[0]?.payload_sha256 ?? null;
      }, { readOnly: true });
      if (fresh !== gate.interimReadPayloadSha256) fail("CUTOVER_INTERIM_READ_NOT_LOADED");
    }
    const live = await markLive(handle, { flipEvidenceSha256, allowedRoleMembers: [...context.inputs.allowedRoleMembers] });
    const body = { schema: `${PRODUCTION_TRANSFER_SCHEMA}-mark-live`, sealId: context.inputs.sealId, runId: live.runId,
      flipGateSha256, flipEvidenceSha256, lockedControlRelations: live.primaryLocked };
    const markLiveSha256 = await writeReceiptOnce(context.path("markLive"), body);
    await step(context, "mark-live", { markLiveSha256 });
    return Object.freeze({ mode: "executed", step: "mark-live", state: live.state, markLiveSha256 });
  });
}

export async function postLiveCheck(context) {
  const { handle, run, released, flipGate: gated } = await finalizeFacts(context);
  assertStepOrder("post-live-check", { runState: run?.state ?? null, released, flipGate: gated });
  const nowMs = context.now().getTime();
  const identity = await identityLinkFacts(context);
  const facts = await withTransferTransaction(handle, "primary", async client => {
    const identityLink = await assertIdentityLinkContinuity(client, handle, identity);
    const { rows } = await client.query(`SELECT retention.state AS retention_state, reconciliation.state AS reconciliation_state,
        retention.maintenance_run_at = reconciliation.maintenance_run_at AS same_cycle,
        (extract(epoch FROM retention.last_completed_at) * 1000)::bigint::text AS retention_completed_ms,
        (extract(epoch FROM reconciliation.last_completed_at) * 1000)::bigint::text AS reconciliation_completed_ms
      FROM ${quote(handle.primarySchema)}.retention_state retention
      CROSS JOIN ${quote(handle.primarySchema)}.quarantine_reconciliation_state reconciliation`);
    return { ...rows[0], identityLink };
  }, { readOnly: true });
  const ages = [facts?.retention_completed_ms, facts?.reconciliation_completed_ms].map(value => nowMs - Number(value));
  if (facts?.retention_state !== "completed" || facts?.reconciliation_state !== "completed" || facts?.same_cycle !== true
      || ages.some(age => !Number.isFinite(age) || age < 0 || age > POST_LIVE_MAXIMUM_PASS_AGE_MILLISECONDS)) {
    fail("CUTOVER_POST_LIVE_NOT_READY");
  }
  // The L1 gate's receipt: content-free and clock-free (no instant and no
  // age), so a later check after another pass computes identical bytes.
  const body = { schema: `${PRODUCTION_TRANSFER_SCHEMA}-post-live-check`, sealId: context.inputs.sealId,
    contractId: context.inputs.contractId, runId: run.runId, ready: true, retentionState: "completed",
    reconciliationState: "completed", sameCycle: true, maximumPassAgeMilliseconds: POST_LIVE_MAXIMUM_PASS_AGE_MILLISECONDS,
    identityLink: facts.identityLink };
  const postLiveCheckSha256 = await writeReceiptOnce(context.path("postLiveCheck"), body);
  await journal(context, "post-live-check", "ready", { postLiveCheckSha256 });
  return Object.freeze({ step: "post-live-check", ready: true, runState: "live", postLiveCheckSha256 });
}

/**
 * L2: every receipt's sha256 and every gate's result. It requires the L1
 * post-live-check receipt (the SWITCH GO gate): without it, it refuses
 * CUTOVER_POST_LIVE_NOT_READY and writes nothing.
 */
export async function writeReport(context) {
  const { run, released, flipGate: gated } = await finalizeFacts(context);
  assertStepOrder("report", { runState: run?.state ?? null, released, flipGate: gated });
  if (!await fileExists(context.path("postLiveCheck"))) fail("CUTOVER_POST_LIVE_NOT_READY", { step: "report" });
  const digests = {};
  const values = {};
  for (const name of ["preflight", "postImport", "release", "flipGate", "markLive", "postLiveCheck", "pin"]) {
    const { value, sha256 } = await readOwnerJson(context.path(name), "CUTOVER_STEP_ORDER_VIOLATION");
    digests[name] = sha256;
    values[name] = value;
  }
  // Round 16: a rotated cutover also reports its rotation document.
  const declared = await readRotation(context);
  if (declared !== null) digests.rotation = declared.rotationSha256;
  const { preflight, flipGate: gate, postLiveCheck: postLive } = values;
  if (!record(preflight) || preflight.verdict !== "GO" || preflight.sealId !== context.inputs.sealId
      || !record(gate) || gate.ready !== true || gate.runId !== run.runId) {
    fail("CUTOVER_STEP_ORDER_VIOLATION", { step: "report" });
  }
  if (!record(postLive) || postLive.ready !== true || postLive.runId !== run.runId || postLive.sealId !== context.inputs.sealId) {
    fail("CUTOVER_POST_LIVE_NOT_READY", { step: "report" });
  }
  const body = { schema: `${PRODUCTION_TRANSFER_SCHEMA}-report`, sealId: context.inputs.sealId,
    contractId: context.inputs.contractId, runId: run.runId, runState: run.state, inputsSha256: context.inputsSha256,
    dispositionPolicySha256: dispositionPolicySha256(), flipEvidenceSha256: run.flipEvidenceSha256, receipts: digests,
    gates: { preflight: "GO", flipGate: "ready", markLive: run.state, postLiveCheck: "ready" } };
  const reportSha256 = await writeReceiptOnce(context.path("report"), body);
  return Object.freeze({ step: "report", reportSha256 });
}

export async function abandon(context, { execute = false, confirm = undefined } = {}) {
  const { handle, run, released, flipGate: gated } = await finalizeFacts(context);
  assertStepOrder("abandon", { runState: run?.state ?? null, released, flipGate: gated });
  const token = authorizationToken("abandon", { sealId: context.inputs.sealId, contractId: context.inputs.contractId,
    inputsSha256: context.inputsSha256, runId: run.runId });
  if (!authorize("abandon", token, { execute, confirm })) {
    return Object.freeze({ mode: "dry-run", step: "abandon", authorizationToken: token });
  }
  return withOrchestratorLocks(context, handle.primarySchema, async () => {
    const result = await abandonRun(handle);
    await step(context, "abandon");
    return Object.freeze({ mode: "executed", step: "abandon", runState: result.state });
  });
}

// ---------------------------------------------------------------------------
// CLI.

const COMMANDS = Object.freeze({
  "identity-pin": { values: ["--owner-dir", "--key-version", "--secret-name", "--secret-version"], switches: [] },
  "identity-rotate-pin": { values: ["--owner-dir", "--from-key-version", "--to-key-version", "--secret-name",
    "--secret-version", "--sealed-pin-file"], switches: [] },
  "target-check": { values: ["--contract", ...["--pg-socket", "--pg-port", "--pg-user", "--pg-database"]], switches: [] },
  preflight: { values: ["--owner-dir", "--pg-socket", "--pg-port", "--pg-user", "--pg-database"], switches: [] },
  run: { values: ["--owner-dir", "--confirm", "--confirm-identity-rotation", "--pg-socket", "--pg-port", "--pg-user",
    "--pg-database"], switches: ["--execute"] },
  "release-controls": { values: ["--owner-dir", "--flip-evidence", "--confirm", "--pg-socket", "--pg-port", "--pg-user",
    "--pg-database"], switches: ["--execute"] },
  "flip-gate": { values: ["--owner-dir", "--flip-evidence", "--pg-socket", "--pg-port", "--pg-user", "--pg-database"], switches: [] },
  "mark-live": { values: ["--owner-dir", "--flip-evidence-sha256", "--confirm", "--pg-socket", "--pg-port", "--pg-user",
    "--pg-database"], switches: ["--execute"] },
  "post-live-check": { values: ["--owner-dir", "--pg-socket", "--pg-port", "--pg-user", "--pg-database"], switches: [] },
  report: { values: ["--owner-dir", "--pg-socket", "--pg-port", "--pg-user", "--pg-database"], switches: [] },
  abandon: { values: ["--owner-dir", "--confirm", "--pg-socket", "--pg-port", "--pg-user", "--pg-database"], switches: ["--execute"] },
});

/** Parse argv into a closed option set; unknown, repeated or valueless flags refuse. */
export function parseTransferArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) fail("CUTOVER_ARGUMENT_INVALID");
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (spec === undefined) fail("CUTOVER_ARGUMENT_INVALID");
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (spec.switches.includes(flag)) {
      if (options[flag] !== undefined) fail("CUTOVER_ARGUMENT_INVALID");
      options[flag] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!spec.values.includes(flag) || options[flag] !== undefined || typeof value !== "string" || value.startsWith("--")) {
      fail("CUTOVER_ARGUMENT_INVALID");
    }
    options[flag] = value;
    index += 1;
  }
  if (command !== "target-check" && options["--owner-dir"] === undefined) fail("CUTOVER_ARGUMENT_INVALID");
  if (command === "target-check" && options["--contract"] === undefined) fail("CUTOVER_ARGUMENT_INVALID");
  if (["release-controls", "flip-gate"].includes(command) && options["--flip-evidence"] === undefined) {
    fail("CUTOVER_ARGUMENT_INVALID");
  }
  if (command === "mark-live" && options["--flip-evidence-sha256"] === undefined) fail("CUTOVER_ARGUMENT_INVALID");
  if (options["--execute"] === true && options["--confirm"] === undefined) fail("CUTOVER_AUTHORIZATION_MISMATCH");
  if (options["--confirm"] !== undefined && options["--execute"] !== true) fail("CUTOVER_EXECUTE_REQUIRED");
  if (command === "identity-pin" && ["--key-version", "--secret-name", "--secret-version"]
    .some(flag => options[flag] === undefined)) {
    fail("CUTOVER_ARGUMENT_INVALID");
  }
  if (command === "identity-rotate-pin" && ["--from-key-version", "--to-key-version", "--secret-name", "--secret-version",
    "--sealed-pin-file"].some(flag => options[flag] === undefined)) {
    fail("CUTOVER_ARGUMENT_INVALID");
  }
  if (options["--confirm-identity-rotation"] !== undefined && options["--execute"] !== true) fail("CUTOVER_EXECUTE_REQUIRED");
  return Object.freeze(options);
}

/**
 * The connection: a local Unix socket only (the Cloud SQL Auth Proxy with
 * --auto-iam-authn in production, the fan-out cluster in rehearsal), in a
 * private directory owned by the caller. No TCP host, no URL.
 */
export async function connectionOptions(options) {
  const socket = options["--pg-socket"];
  const port = Number(options["--pg-port"]);
  const user = options["--pg-user"];
  const database = options["--pg-database"];
  if (typeof socket !== "string" || !isAbsolute(socket) || !PRIVATE_SOCKET_ROOTS.some(root => socket.startsWith(root))
      || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || typeof user !== "string" || !ROLE_NAME.test(user) || typeof database !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(database)) {
    fail("CUTOVER_CONNECTION_INVALID");
  }
  let resolved;
  let metadata;
  try {
    resolved = await realpath(socket);
    metadata = await stat(resolved);
  } catch {
    fail("CUTOVER_CONNECTION_INVALID");
  }
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
    fail("CUTOVER_CONNECTION_INVALID");
  }
  return Object.freeze({ host: resolved, port, user, database, ssl: false, max: 4, connectionTimeoutMillis: 15_000,
    application_name: "tibotattle-pt8-lite" });
}

async function main(argv, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const options = parseTransferArguments(argv);
  const print = value => stdout.write(`${JSON.stringify(value)}\n`);
  if (options.command === "identity-pin") {
    print(await writeIdentityPin({ ownerDirectory: resolve(options["--owner-dir"]), stream: stdin,
      keyVersion: options["--key-version"], secretName: options["--secret-name"], secretVersion: options["--secret-version"] }));
    return;
  }
  if (options.command === "identity-rotate-pin") {
    print(await writeIdentityRotation({ ownerDirectory: resolve(options["--owner-dir"]), stream: stdin,
      sealedPinFile: resolve(options["--sealed-pin-file"]), fromKeyVersion: options["--from-key-version"],
      toKeyVersion: options["--to-key-version"], secretName: options["--secret-name"],
      secretVersion: options["--secret-version"] }));
    return;
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ ...await connectionOptions(options), password: process.env.PGPASSWORD });
  pool.on("error", () => {});
  try {
    if (options.command === "target-check") {
      print(await targetCheck({ pool, contractId: options["--contract"] }));
      return;
    }
    const context = await createTransferContext({ ownerDirectory: resolve(options["--owner-dir"]), pool });
    const authorization = { execute: options["--execute"] === true, confirm: options["--confirm"] };
    const handlers = {
      preflight: () => runPreflight(context),
      run: () => runImport(context, { ...authorization,
        confirmIdentityRotation: options["--confirm-identity-rotation"] }),
      "release-controls": () => releaseControls(context, { flipEvidencePath: resolve(options["--flip-evidence"]), ...authorization }),
      "flip-gate": () => flipGate(context, { flipEvidencePath: resolve(options["--flip-evidence"]) }),
      "mark-live": () => markLiveStep(context, { flipEvidenceSha256: options["--flip-evidence-sha256"], ...authorization }),
      "post-live-check": () => postLiveCheck(context),
      report: () => writeReport(context),
      abandon: () => abandon(context, authorization),
    };
    print(await handlers[options.command]());
  } finally {
    await pool.end().catch(() => {});
  }
}

export function cliErrorLine(error) {
  return JSON.stringify({ error: isContentFreeError(error) ? error.message : "CUTOVER_ORCHESTRATOR_FAILED" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${cliErrorLine(error)}\n`);
    process.exitCode = error?.code === "CUTOVER_ARGUMENT_INVALID" || error?.code === "CUTOVER_AUTHORIZATION_MISMATCH"
      || error?.code === "CUTOVER_EXECUTE_REQUIRED" ? 2 : 1;
  });
}
