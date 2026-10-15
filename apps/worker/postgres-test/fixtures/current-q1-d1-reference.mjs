/**
 * Fresh current-code D1 reference for the immutable, synthetic Q-1 inputs.
 * This is deliberately separate from every historical oracle/golden. It never
 * restores an old database, relabels a runtime, reads PostgreSQL, or substitutes
 * historical published values. Run alone: its reversible clock/random adapters
 * are process-wide, and the owner controls the exclusive qualification lane.
 *
 *   node current-q1-d1-reference.mjs --out /absolute/new-reference.json
 *
 * Output is synthetic DTOs and provenance only. A missing publication remains
 * missing; a bounded native probe must actually execute before it can establish
 * a refusal. Unresolved work produces an explicitly non-qualifying result.
 */
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  advanceCurrentQ1CachePass, assertCurrentQ1ControlTransition, assertCurrentQ1SourceUnchanged, captureCurrentQ1SourceInvariant,
  captureCurrentQ1SourceInvariantDetails,
  proveCurrentQ1StrictExportRefusal, runCurrentQ1DailyConvergence, runCurrentQ1Recomputation,
  validateCurrentQ1CorpusConvergence, validateCurrentQ1Recomputation, validateCurrentQ1StrictExportRefusal,
} from "./current-q1-d1-recompute.mjs";
import { createS9Progress } from "../../scripts/s9-rehearsal-diagnostics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
export const CURRENT_Q1_REFERENCE_NOW_MS = 1_790_856_000_000;
export const CURRENT_Q1_REFERENCE_SOURCE_ID = "gcp-fastpath-oracle";
const NAMESPACE = CURRENT_Q1_REFERENCE_SOURCE_ID;
const CORPUS_SOURCE = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";
const CORPUS_SHA = "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e";
const DAY_MS = 86_400_000;
const STREAMS = Object.freeze(["quota", "session", "usage"]);
const V11_PARSER_VERSION = "synthetic-gcp-oracle-v11";
const V12_PARSER_VERSION = "synthetic-gcp-oracle-v12";
const V1_PARSER_VERSION = "synthetic-gcp-oracle-v1";
const ADMISSION_CHUNK_RECORDS = 200;
const V1_CONSENT = Object.freeze({ telemetrySchemaVersion: "telemetry-contribution-v1.0",
  fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" });
const INGESTION_MIGRATIONS = Object.freeze(["migrations", "typed-ingestion-migrations",
  "ingestion-bridge-migrations", "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations"]);
const BOUNDS = Object.freeze({ bootstrap: 64, settleRounds: 8, delivery: 512,
  daily: 256, dailyConvergence: 4_096, forcedDailyPerHead: 64, dailyRetirement: 16, cachePasses: 4_096,
  nativeInvocations: 128, nativeStall: 8 });
const ERRORS = Object.freeze(["CURRENT_Q1_BUSY", "CURRENT_Q1_INPUT_INVALID", "CURRENT_Q1_CORPUS_INVALID",
  "CURRENT_Q1_SOURCE_CHANGED", "CURRENT_Q1_RUNTIME_UNSUPPORTED", "CURRENT_Q1_MIGRATION_FAILED",
  "CURRENT_Q1_ADMISSION_FAILED", "CURRENT_Q1_NOT_SETTLED", "CURRENT_Q1_ORACLE_FAILED",
  "CURRENT_Q1_PUBLIC_READ_FAILED", "CURRENT_Q1_SCRATCH_INVALID", "CURRENT_Q1_CLEANUP_FAILED",
  "CURRENT_Q1_OUTPUT_INVALID", "CURRENT_Q1_EXECUTION_FAILED", "CURRENT_Q1_REFERENCE_BINDING_INVALID"]);
const ORACLE_CODES = new Set(["ANALYTICS_EXPORT_NOT_QUIESCENT", "ORACLE_NOT_CONVERGED", "ANALYTICS_EXPORT_INPUT_INVALID",
  "ANALYTICS_EXPORT_SCHEMA_INVALID", "ANALYTICS_EXPORT_IDENTITY_MISMATCH", "ANALYTICS_EXPORT_INTEGRITY_FAILED",
  "ORACLE_BUSY", "ANALYTICS_EXPORT_CLOCK_UNPINNED"]);
const QUIESCENCE_REASONS = new Set(["queue_rows", "cursor_not_at_journal_max", "cursor_receipt",
  "terminal_undelivered", "erasure_jobs_pending", "cache_retention_incomplete", "stale_head"]);
const TRUSTED_NODE_BINARIES = Object.freeze({
  "darwin/arm64": "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
  "linux/x64": "030a5e93e4f7a022b12a3ec80fecd22af9614356904a05ece6b1b2dbf4c1f588",
});
const READINESS_CODES = Object.freeze(["public_envelope_invalid", "public_daily_set_incomplete",
  "public_daily_contract_invalid", "public_daily_reference_mismatch", "current_admin_preview_incomplete",
  "current_admin_catalog_invalid", "current_public_projection_invalid", "current_cache_missing_or_mismatched"]);
const REQUIRED_FUNCTIONS = Object.freeze([
  "ApiError", "D1AnalyticsExportOracleError", "StorageGraphOperationError", "advanceStorageCommunityGraphWork",
  "analyticsHistoryGraphWindow", "canonicalD1TableDigest", "captureStorageCommunityAuthority", "normalizedDailyPayloadSha256",
  "readCollectionControls", "setCollectionControls", "readD1AnalyticsLiveCohort", "readD1AnalyticsImportSelection",
  "readEffectiveTelemetryOwnerDayPage", "readStorageCommunitySourceTerminalEpoch", "readStorageCommunityDeliveredTerminalEpoch",
  "storageHistoryKeyDigest", "storageGraphV11CheckpointMethod",
  "publishStorageCommunityModelDay", "publishStorageCommunityGraphPreview", "retireStorageCommunityGraphPublications", "activateTelemetryV11Domain", "activateTelemetryV12Domain",
  "advanceCacheRetentionDayLane", "advanceNextStorageCommunityDaily", "advanceStorageAnalytics", "authenticateDevice",
  "buildCommunityDailyPayload", "buildCurrentPublicModelMetadata", "canonicalJson", "canonicalTelemetryV12Json",
  "captureStorageGraphScope", "claimDeviceUploadAuthorization", "computeStorageGraphResult", "createAccountlessUploadOwner",
  "createCacheRetentionDaySourceBuild", "createDeviceUploadAuthorization", "createTelemetryV11DomainPredecessor",
  "createTelemetryV12DomainPredecessor", "createV11DeviceFixture", "currentTelemetryV1Chunk",
  "drainCommunityPublicSourceBootstrap", "encodeBase64Url", "enrollAccountlessDevice", "grantTelemetryV12Consent",
  "handleRequest", "initializeStorageAnalyticsRuntime", "initializeStorageSource", "initializeTypedV11Admission",
  "initializeTypedV1Admission", "insertTypedTelemetryV1Chunk", "isCurrentCommunityDailySpend", "makeV11Day",
  "parseAccountlessEnrollmentRequest", "parseAccountlessOwnershipRequest", "parseTelemetryV11Record", "parseTelemetryV12Record",
  "parseTelemetryV12Chunk", "parseTelemetryV1Chunk", "persistTelemetryV12StagedChunk", "persistTypedV11StagedChunk",
  "projectPublicAllowanceGraph", "putTrackedQuarantineObject", "readCacheRetentionCommunitySeries",
  "readPublishedStorageCommunityAdminPreview", "readPublishedStorageCommunityDaily", "readPublishedStorageCommunityGraph",
  "readStorageCommunityOwnerPage", "readStorageGraphResult", "registerTelemetryV11DayManifest",
  "registerTelemetryV12DayManifest", "retireStorageCommunityDailyPage", "runD1AnalyticsExportOracle", "sha256Hex",
  "telemetryV11DomainManifestDigestInput", "telemetryV11LegacyProjection", "telemetryV12DayManifestDigestInput",
  "telemetryV12DomainManifestDigestInput", "telemetryV12RequiredConsent", "validCachedAdminCommunityAllowancePreview",
  "validateTelemetryV12DayUsageOrder", "wrapPublicAllowanceBreakdownsV15",
]);
const ADMISSION_FUNCTIONS = Object.freeze([
  "activateTelemetryV11Domain", "activateTelemetryV12Domain", "authenticateDevice", "canonicalJson", "canonicalTelemetryV12Json",
  "claimDeviceUploadAuthorization", "createAccountlessUploadOwner", "createDeviceUploadAuthorization",
  "createTelemetryV11DomainPredecessor", "createTelemetryV12DomainPredecessor", "createV11DeviceFixture",
  "currentTelemetryV1Chunk", "encodeBase64Url", "enrollAccountlessDevice", "grantTelemetryV12Consent",
  "insertTypedTelemetryV1Chunk", "makeV11Day", "parseAccountlessEnrollmentRequest", "parseAccountlessOwnershipRequest",
  "parseTelemetryV12Chunk", "parseTelemetryV1Chunk", "persistTelemetryV12StagedChunk", "persistTypedV11StagedChunk",
  "putTrackedQuarantineObject", "registerTelemetryV11DayManifest", "registerTelemetryV12DayManifest", "sha256Hex",
  "telemetryV11DomainManifestDigestInput", "telemetryV11LegacyProjection", "telemetryV12DayManifestDigestInput",
  "telemetryV12DomainManifestDigestInput", "telemetryV12RequiredConsent",
]);
const ADMISSION_OPERATIONS = Object.freeze(["none", ...ADMISSION_FUNCTIONS, "owner_link_write", "accountless_owner_read"]);
// Exact current ApiError ErrorCode union, accepted only for its actual class.
// No arbitrary error code, name, message or namespace prefix is admitted.
const ADMISSION_API_CODES = new Set([
  "ACCESS_REQUIRED", "ACCOUNT_SCOPED_CONFIGURATION_INVALID", "ACCOUNT_SCOPED_INGEST_DISABLED", "ACCOUNT_SCOPED_LOCAL_ONLY",
  "ACCOUNTLESS_ENROLLMENT_CONFLICT", "ACCOUNTLESS_ENROLLMENT_DISABLED", "ACCOUNTLESS_ENROLLMENT_EXPIRED", "ACCOUNTLESS_ENROLLMENT_LIMIT_REACHED",
  "ACCOUNTLESS_ENROLLMENT_REVOKED", "ACCOUNTLESS_OWNERSHIP_CONFIGURATION_INVALID", "ACCOUNTLESS_OWNERSHIP_CONFLICT", "ACCOUNTLESS_OWNERSHIP_DISABLED",
  "ACCOUNTLESS_OWNERSHIP_EXPIRED", "ACCOUNTLESS_OWNERSHIP_REVOKED", "ADMIN_ACTION_CONFLICT", "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE",
  "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE", "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE", "ADMIN_METRICS_HISTORY_STORAGE_UNAVAILABLE", "ADMIN_RECONSTRUCTION_PROGRESS_UNAVAILABLE",
  "ADMIN_NOT_CONFIGURED", "ADMIN_REQUIRED", "ADMISSION_RATE_LIMIT_UNAVAILABLE", "ADMISSION_CONFIGURATION_INVALID",
  "AUTH_REQUIRED", "AUTH_INVALID", "ATTEMPT_LIMIT_REACHED", "SIGN_IN_START_LIMIT_REACHED",
  "BACKEND_STORAGE_UNAVAILABLE", "BODY_INVALID", "BODY_TIMEOUT", "BODY_TOO_LARGE",
  "CHUNK_ADMISSION_LIMIT_REACHED", "CHUNK_DIGEST_MISMATCH", "CHUNK_INVALID", "CHUNK_REVISION_CONFLICT",
  "CONTENT_TYPE_INVALID", "CONTRIBUTION_LIMIT_REACHED", "CONTRIBUTION_DELETE_CONFLICT", "COLLECTION_CONTROL_UNAVAILABLE",
  "COLLECTION_ENROLLMENT_DISABLED", "DEPLOYMENT_SOURCE_COMMIT_INVALID", "CSRF_INVALID", "DELETION_LEDGER_UNAVAILABLE",
  "DECRYPTION_FAILED", "DEVICE_AUTH_INVALID", "DEVICE_CONTINUITY_REQUIRED", "DEVICE_NOT_FOUND",
  "DISTRIBUTION_SYNC_UNAVAILABLE", "ENVELOPE_INVALID", "IDENTITY_CONFIGURATION_INVALID", "IDENTITY_PROVIDER_UNAVAILABLE",
  "IDENTITY_REQUIRED", "IDENTITY_RESULT_PENDING", "IDENTITY_REENROLLMENT_COOLDOWN", "IDENTITY_TOKEN_INVALID",
  "INTERNAL_ERROR", "INVITE_GRANT_INVALID", "ENROLLMENT_DISABLED", "KEY_CONFIGURATION_INVALID",
  "KEY_ID_INVALID", "LIFECYCLE_BOUNDS_EXCEEDED", "LIFECYCLE_STATE_CONFLICT", "METHOD_NOT_ALLOWED",
  "MUTATION_BARRIER_ACTIVE", "NOT_FOUND", "PARTICIPANT_DELETING", "PAIRING_AUTH_INVALID",
  "PROCESSING_DISABLED", "PRIVACY_CANARY_DETECTED", "PUBLICATION_DISABLED", "POSTGRES_REQUEST_PATH_UNSUPPORTED",
  "RECORD_OWNED_BY_OTHER_CHUNK", "SPARKLE_APPCAST_GUARD_AUTH_INVALID", "SPARKLE_APPCAST_GUARD_BODY_TOO_LARGE", "SPARKLE_APPCAST_GUARD_CANDIDATE_INVALID",
  "SPARKLE_APPCAST_GUARD_CONFIGURATION_INVALID", "SPARKLE_APPCAST_GUARD_REQUEST_INVALID", "SPARKLE_APPCAST_GUARD_REPLAY_INVALID", "SPARKLE_APPCAST_GUARD_TARGET_INVALID",
  "SPARKLE_APPCAST_GUARD_STORAGE_UNAVAILABLE", "SYNC_RANGE_TOO_LARGE", "SYNTHETIC_RECORD_INVALID", "SYNTHETIC_REQUIRED",
  "TELEMETRY_CONSENT_INVALID", "TELEMETRY_TRANSPORT_BLOCKED", "TELEMETRY_MANIFEST_INVALID", "TELEMETRY_MANIFEST_CONFLICT",
  "TELEMETRY_MANIFEST_INCOMPLETE", "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE", "TELEMETRY_RECORD_INVALID", "TELEMETRY_OCCURRENCE_CONFLICT",
  "TELEMETRY_STORAGE_CONSTRAINT", "TELEMETRY_REQUIRED", "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE", "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED",
  "UPLOAD_AUTH_INVALID", "UPLOAD_ADMISSION_LIMIT_REACHED", "UPLOAD_INGRESS_LIMIT_REACHED", "UPLOAD_INGRESS_UNAVAILABLE",
  "UPLOAD_REGISTRATION_DISABLED", "UPLOAD_IN_PROGRESS",
]);
const ADMISSION_SQLITE_CODES = new Set(["ERR_SQLITE_ERROR", "ERR_SQLITE_BUSY", "ERR_SQLITE_MISUSE"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value) => sha(JSON.stringify(value));
const requireFact = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
let held = false;

/** Pins were verified independently against official Node 26.2.0 archives.
 * Operational execution always supplies the measured current process binding;
 * callers cannot inject a runtime binding into runCurrentQ1D1Reference(). */
export function assertCurrentQ1TrustedRuntime({ version, platform, arch, binarySha256 }) {
  requireFact(version === "v26.2.0" && Object.hasOwn(TRUSTED_NODE_BINARIES, `${platform}/${arch}`)
    && binarySha256 === TRUSTED_NODE_BINARIES[`${platform}/${arch}`], "CURRENT_Q1_RUNTIME_UNSUPPORTED");
}

async function boundedFile(path) {
  const metadata = await lstat(path);
  requireFact(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 32 * 1024 * 1024,
    "CURRENT_Q1_INPUT_INVALID");
  return readFile(path);
}

async function runtimeBinarySha256(path) {
  const metadata = await lstat(path);
  requireFact(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 512 * 1024 * 1024,
    "CURRENT_Q1_RUNTIME_UNSUPPORTED");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

/** Exact current source bytes, copied workspace packages and dependency locks.
 * No database, environment file or private corpus can enter this closure. */
async function sourceSnapshot(additionalWorkerPaths = [], { validateSourcePath, strictPublicPackageRoots = false } = {}) {
  const rootFiles = new Set(["package.json", "pnpm-lock.yaml"]);
  const copiedPackages = new Set(["accounting", "quota-analysis", "telemetry-contract"]);
  const validAdditionalPath = (path) => {
    if (typeof path !== "string" || path.length < 1 || path.length > 1024
      || /[\\\0\r\n]/u.test(path)) return false;
    if (rootFiles.has(path)) return true;
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".."
      || [".git", ".private", ".cache", ".codex", "secrets", "generated-inputs", "private-generated", "raw-history"]
        .includes(part)
      || /^\.(?:env(?:\.|$)|dev\.vars(?:\.|$)|envrc$|npmrc$|yarnrc(?:\.|$))/u.test(part))) return false;
    if (parts.includes("node_modules")) return parts.filter((part) => part === "node_modules").length === 1
      && parts.slice(0, 4).join("/") === "apps/worker/node_modules/@app-usagemonitor"
      && copiedPackages.has(parts[4]) && parts.length >= 6
      && parts.slice(5).every((part) => /^[A-Za-z0-9._-]+$/u.test(part));
    return ["apps", "packages", "scripts", "src"].includes(parts[0]) && parts.length >= 2
      && parts.every((part) => /^[A-Za-z0-9._-]+$/u.test(part));
  };
  requireFact(Array.isArray(additionalWorkerPaths) && additionalWorkerPaths.length <= 64
    && additionalWorkerPaths.every(validAdditionalPath), "CURRENT_Q1_INPUT_INVALID");
  requireFact(validateSourcePath === undefined || typeof validateSourcePath === "function",
    "CURRENT_Q1_INPUT_INVALID");
  requireFact(typeof strictPublicPackageRoots === "boolean", "CURRENT_Q1_INPUT_INVALID");
  const paths = [];
  const assertCanonicalPath = async (path) => {
    const relativePath = relative(REPOSITORY_ROOT, path);
    requireFact(relativePath && relativePath !== ".." && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(relativePath) && await realpath(REPOSITORY_ROOT) === REPOSITORY_ROOT,
    "CURRENT_Q1_INPUT_INVALID");
    let current = REPOSITORY_ROOT;
    for (const segment of relativePath.split("/")) {
      current = join(current, segment);
      const metadata = await lstat(current);
      requireFact(!metadata.isSymbolicLink(), "CURRENT_Q1_INPUT_INVALID");
    }
    requireFact(await realpath(path) === path, "CURRENT_Q1_INPUT_INVALID");
  };
  const collect = async (path) => {
    const metadata = await lstat(path);
    requireFact(!metadata.isSymbolicLink(), "CURRENT_Q1_INPUT_INVALID");
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await collect(join(path, name));
    } else {
      const relativePath = relative(REPOSITORY_ROOT, path);
      requireFact(metadata.isFile() && paths.length < 10_000
        && (validateSourcePath === undefined || validateSourcePath(relativePath)), "CURRENT_Q1_INPUT_INVALID");
      paths.push(path);
    }
  };
  const publicPackageRoots = strictPublicPackageRoots
    ? ["node_modules/@app-usagemonitor/accounting", "node_modules/@app-usagemonitor/quota-analysis",
      "node_modules/@app-usagemonitor/telemetry-contract"]
    : ["node_modules/@app-usagemonitor"];
  for (const path of ["src", ...publicPackageRoots, "test/helpers/telemetry-v11.ts",
    "package.json", "package-lock.json", "wrangler.jsonc", "cloud-run/sealed-sqlite-d1-adapter.mjs",
    "postgres-test/fixtures/current-q1-d1-reference.mjs", "postgres-test/fixtures/current-q1-d1-recompute.mjs", "scripts/s9-rehearsal-diagnostics.mjs", ...INGESTION_MIGRATIONS,
    "analytics-migrations", "deletion-ledger-migrations"]) {
    const absolute = join(WORKER_ROOT, path);
    if (strictPublicPackageRoots) await assertCanonicalPath(absolute);
    await collect(absolute);
  }
  if (strictPublicPackageRoots) {
    // D7 pins the canonical public package code alongside the exact installed
    // copies. Do not walk package documentation or generated artifacts: only
    // the published entrypoints and reviewed source roots are part of this
    // runtime closure.
    for (const packageName of ["accounting", "quota-analysis", "telemetry-contract"]) {
      const packageRoot = join(REPOSITORY_ROOT, "packages", packageName);
      for (const entry of ["package.json", "index.js", "index.d.ts"]) {
        const path = join(packageRoot, entry);
        try { await lstat(path); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
        await assertCanonicalPath(path);
        await collect(path);
      }
      for (const directory of ["src", "scripts", "schemas"]) {
        const path = join(packageRoot, directory);
        try { await lstat(path); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
        await assertCanonicalPath(path);
        await collect(path);
      }
    }
  }
  for (const path of additionalWorkerPaths) {
    const absolute = join(REPOSITORY_ROOT, path);
    if (validateSourcePath !== undefined) {
      requireFact(validateSourcePath(path) && relative(REPOSITORY_ROOT, absolute) === path,
        "CURRENT_Q1_INPUT_INVALID");
      await assertCanonicalPath(absolute);
    }
    await collect(absolute);
  }
  const files = [];
  for (const path of paths.sort()) {
    const relativePath = relative(REPOSITORY_ROOT, path);
    requireFact(validateSourcePath === undefined || validateSourcePath(relativePath), "CURRENT_Q1_INPUT_INVALID");
    requireFact(validateSourcePath === undefined || await realpath(path) === path,
      "CURRENT_Q1_INPUT_INVALID");
    files.push({ path: relativePath, sha256: sha(await boundedFile(path)) });
  }
  const { stdout } = await promisify(execFile)("git", ["--no-optional-locks", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"],
    { timeout: 10_000, maxBuffer: 1_024, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } });
  requireFact(/^[a-f0-9]{40}\n$/u.test(stdout), "CURRENT_Q1_INPUT_INVALID");
  return { head: stdout.trim(), files, sha256: jsonSha(files) };
}

/** Public read-only provenance seam shared by the versioned D7 producer. */
export async function captureCurrentQ1SourceSnapshot(additionalWorkerPaths = [], options = {}) {
  requireFact(typeof options?.validateSourcePath === "function" && options.strictPublicPackageRoots === true,
    "CURRENT_Q1_INPUT_INVALID");
  return sourceSnapshot(additionalWorkerPaths, options);
}

async function corpusInput(P) {
  const root = join(WORKER_ROOT, "analytics-v2-test/golden/corpus");
  const names = ["corpus.json", ...["a", "b", "c", "d"].map((key) => `corpus-owner-${key}.json`)];
  const bytes = await Promise.all(names.map((name) => boundedFile(join(root, name))));
  const [index, ...shards] = bytes.map((value) => JSON.parse(value));
  requireFact(jsonSha([index, ...shards]) === CORPUS_SHA && index.synthetic === true
    && index.schemaVersion === "gcp-fastpath-oracle-corpus-v1" && index.sourceCommit === CORPUS_SOURCE
    && index.seed === "gcp-fastpath-oracle-2026-10-01" && index.pinnedNow === "2026-10-01T12:00:00.000Z"
    && index.correctionRuntimeState === "active" && index.window.fromDay === "2026-04-15"
    && index.window.throughDay === "2026-10-01" && index.window.days === 170
    && index.owners.map((owner) => owner.key).join("") === "abcd", "CURRENT_Q1_CORPUS_INVALID");
  let recordCount = 0;
  const owners = index.owners.map((owner, n) => {
    const shard = shards[n];
    requireFact(index.shards[owner.key] === names[n + 1] && shard.key === owner.key && shard.days.length === 170
      && owner.dayCount === 170 && /^[a-f0-9]{64}$/u.test(owner.pinnedOwnerDigest), "CURRENT_Q1_CORPUS_INVALID");
    const counts = { quota: 0, session: 0, usage: 0 };
    for (const [dayIndex, day] of shard.days.entries()) {
      const expected = new Date(Date.parse(index.window.fromDay) + dayIndex * DAY_MS).toISOString().slice(0, 10);
      requireFact(day.day === expected && day.format === (owner.key === "c" ? "v12" : "v11")
        && Object.keys(day.records).sort().join(",") === "quota,session,usage", "CURRENT_Q1_CORPUS_INVALID");
      for (const stream of STREAMS) {
        requireFact(Array.isArray(day.records[stream]), "CURRENT_Q1_CORPUS_INVALID");
        for (const row of day.records[stream]) {
          if (P !== null) validateCorpusRecord(owner.key === "c" ? P.parseTelemetryV12Record : P.parseTelemetryV11Record,
            stream, row);
          counts[stream]++; recordCount++;
        }
        for (const row of day.v1Extra?.[stream] ?? []) {
          if (P !== null) validateCorpusRecord(P.parseTelemetryV11Record, stream, row);
          recordCount++;
        }
      }
      if (P !== null && owner.key === "c") {
        const usage = structuredClone(day.records.usage), before = jsonSha(usage);
        P.validateTelemetryV12DayUsageOrder(day.day, usage);
        requireFact(jsonSha(usage) === before, "CURRENT_Q1_CORPUS_INVALID");
      }
    }
    requireFact(JSON.stringify(counts) === JSON.stringify(index.recordCounts[owner.key]), "CURRENT_Q1_CORPUS_INVALID");
    return { ...owner, days: shard.days };
  });
  requireFact(recordCount === 14_832, "CURRENT_Q1_CORPUS_INVALID");
  const days = Array.from({ length: index.window.days }, (_, n) =>
    new Date(Date.parse(index.window.fromDay) + n * DAY_MS).toISOString().slice(0, 10));
  requireFact(index.conflict.owner === "a" && index.conflict.v1AdmittedAfterV11Domain === true
    && index.conflict.days.length === 2 && index.conflict.days.every((day) => days.includes(day)), "CURRENT_Q1_CORPUS_INVALID");
  return { owners, window: index.window, expectedDailyDays: days.filter((day) => !index.conflict.days.includes(day)), conflictDays: [...index.conflict.days].sort(),
    provenance: { synthetic: true, sourceCommit: CORPUS_SOURCE,
    canonicalSha256: CORPUS_SHA, recordCount, primaryRecordCount: 14_830, owners: 4, daysPerOwner: 170,
    files: names.map((name, n) => ({ path: `apps/worker/analytics-v2-test/golden/corpus/${name}`,
      sha256: sha(bytes[n]) })) } };
}

async function prepareCurrentQ1V11Day(P, day, records) {
  return P.makeV11Day(day, records, V11_PARSER_VERSION);
}

async function prepareCurrentQ1V12Day(P, day, records) {
  const consent = P.telemetryV12RequiredConsent(), chunks = [];
  for (const stream of STREAMS) {
    for (let offset = 0; offset < records[stream].length; offset += ADMISSION_CHUNK_RECORDS) {
      const rows = records[stream].slice(offset, offset + ADMISSION_CHUNK_RECORDS);
      chunks.push({ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${day}:${offset / ADMISSION_CHUNK_RECORDS}`, chunkRevision: 1,
        chunkDigest: await P.sha256Hex(P.canonicalTelemetryV12Json(rows)), parserVersion: V12_PARSER_VERSION,
        consent, records: rows });
    }
  }
  const manifest = { schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion: V12_PARSER_VERSION,
    consent, chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
      recordCount: chunk.records.length })), excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await P.sha256Hex(P.telemetryV12DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

async function prepareCurrentQ1V1Chunks(P, participantId, day, recordsByStream) {
  const prepared = [];
  for (const stream of STREAMS) {
    const sourceRecords = recordsByStream[stream] ?? [];
    const rows = sourceRecords.map((record) => {
      const projected = P.telemetryV11LegacyProjection(stream, record);
      requireFact(projected !== null, "CURRENT_Q1_ADMISSION_FAILED");
      return JSON.parse(projected.canonicalRecord);
    });
    for (let offset = 0; offset < rows.length; offset += ADMISSION_CHUNK_RECORDS) {
      const page = rows.slice(offset, offset + ADMISSION_CHUNK_RECORDS), seq = offset / ADMISSION_CHUNK_RECORDS;
      const chunk = P.parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0",
        chunkId: `${stream}:${day}:${seq}`, chunkRevision: 1,
        chunkDigest: await P.sha256Hex(P.canonicalJson(page)), parserVersion: V1_PARSER_VERSION,
        consent: { ...V1_CONSENT }, records: page });
      prepared.push({ stream, seq, chunk, admission: { participantId, format: "v1", day,
        chunkDigest: chunk.chunkDigest, stream, records: page.length, corpusRowsSha256: jsonSha(sourceRecords) } });
    }
  }
  return prepared;
}

function currentQ1PrimaryAdmission(participantId, format, day, prepared) {
  return { participantId, format, day, manifestDigest: prepared.manifest.manifestDigest,
    chunks: prepared.manifest.chunks.map(({ chunkId, chunkDigest, recordCount }) => ({ chunkId, chunkDigest, recordCount })) };
}

/** Derive the exact admission identity contract from the pinned corpus through
 * the current public builders. This is pure in-memory work: no database,
 * receipt, admission object, or serialized raw row is used as an expectation. */
export async function buildCurrentQ1AdmissionIdentities(P, corpus) {
  const code = "CURRENT_Q1_REFERENCE_BINDING_INVALID";
  const required = ["makeV11Day", "sha256Hex", "canonicalTelemetryV12Json", "telemetryV12DayManifestDigestInput",
    "telemetryV12RequiredConsent", "parseTelemetryV12Chunk", "telemetryV11LegacyProjection", "canonicalJson",
    "parseTelemetryV1Chunk"];
  requireFact(P !== null && typeof P === "object" && required.every((name) => typeof P[name] === "function")
    && corpus && Array.isArray(corpus.owners) && corpus.owners.length === 4
    && corpus.owners.every((owner) => object(owner) && ["a", "b", "c", "d"].includes(owner.key)
      && Array.isArray(owner.days) && owner.days.length === 170), code);
  let input;
  try { input = structuredClone(corpus); } catch { requireFact(false, code); }
  const inputSha256 = jsonSha(input);
  const entries = [];
  for (const owner of input.owners) {
    const format = owner.key === "c" ? "v12" : "v11";
    for (const day of owner.days) {
      const prepared = format === "v12"
        ? await prepareCurrentQ1V12Day(P, day.day, day.records)
        : await prepareCurrentQ1V11Day(P, day.day, day.records);
      if (format === "v12") for (const chunk of prepared.chunks) P.parseTelemetryV12Chunk(chunk);
      entries.push(currentQ1PrimaryAdmission(owner.participantId, format, day.day, prepared));
      for (const [stream, records] of Object.entries(day.v1Extra ?? {})) {
        if (records.length === 0) continue;
        for (const { admission } of await prepareCurrentQ1V1Chunks(P, owner.participantId, day.day, { [stream]: records })) {
          entries.push(admission);
        }
      }
    }
  }
  entries.sort((left, right) => {
    const a = JSON.stringify([left.participantId, left.format, left.day]);
    const b = JSON.stringify([right.participantId, right.format, right.day]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  requireFact(jsonSha(input) === inputSha256, code);
  return entries;
}

function capturedCorpusStructure(corpus, admissionIdentities) {
  const entries = corpus.owners.flatMap((owner) => owner.days.flatMap((day) =>
    Object.entries(day.v1Extra ?? {}).filter(([, records]) => records.length > 0).map(([stream, records]) => ({
      ownerKey: owner.key, participantId: owner.participantId, day: day.day, format: "v1", stream, records: records.length,
      corpusRowsSha256: jsonSha(records),
    })))).sort((left, right) => {
    const a = `${left.ownerKey}\0${left.day}\0${left.stream}`, b = `${right.ownerKey}\0${right.day}\0${right.stream}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const v1ExtraAdmissions = { count: entries.length, sha256: jsonSha(entries), entries };
  requireFact(v1ExtraAdmissions.count === 2, "CURRENT_Q1_CORPUS_INVALID");
  return { owners: corpus.owners.map(({ key, participantId, pinnedOwnerDigest, models }) =>
    ({ key, participantId, pinnedOwnerDigest, models })), window: corpus.window,
  expectedDailyDays: corpus.expectedDailyDays, conflictDays: corpus.conflictDays, v1ExtraAdmissions, admissionIdentities };
}

const MIGRATION_APPLY_ORDER = Object.freeze([...INGESTION_MIGRATIONS.slice(0, 4), "analytics-migrations",
  "deletion-ledger-migrations", ...INGESTION_MIGRATIONS.slice(4)]);
const SHA256 = /^[a-f0-9]{64}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const safeSourcePath = (path) => typeof path === "string" && path.startsWith("apps/worker/")
  && !/[\0\r\n\\]/u.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

function orderedMigrationInputs(sourceFiles) {
  return MIGRATION_APPLY_ORDER.flatMap((directory) => sourceFiles.filter((entry) =>
    entry.path.startsWith(`apps/worker/${directory}/`)
    && /^\d{4}_[a-z0-9_-]+\.sql$/u.test(entry.path.slice(`apps/worker/${directory}/`.length)))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Expose the existing migration ordering to the versioned D7 binder. */
export function orderedCurrentQ1MigrationInputs(sourceFiles) {
  return orderedMigrationInputs(sourceFiles);
}

async function measuredRuntime() {
  requireFact(process.version === "v26.2.0" && Object.hasOwn(TRUSTED_NODE_BINARIES, `${process.platform}/${process.arch}`),
    "CURRENT_Q1_RUNTIME_UNSUPPORTED");
  const runtime = { version: process.version, platform: process.platform, arch: process.arch,
    binarySha256: await runtimeBinarySha256(await realpath(process.execPath)),
    pinnedNowMs: CURRENT_Q1_REFERENCE_NOW_MS, randomSeed: "current-q1-reference", sqliteVersion: process.versions.sqlite };
  assertCurrentQ1TrustedRuntime(runtime);
  return runtime;
}

/** Reuse the current producer's independently measured runtime pin. */
export async function measureCurrentQ1Runtime() {
  return measuredRuntime();
}

function freezeTree(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeTree(item);
  return Object.freeze(value);
}

export function assertCurrentQ1BindingScratchIdentity(before, after) {
  requireFact(before?.isDirectory() && !before.isSymbolicLink() && before.uid === process.getuid()
    && (before.mode & 0o077) === 0 && after?.isDirectory() && !after.isSymbolicLink()
    && after.uid === process.getuid() && after.dev === before.dev && after.ino === before.ino
    && (after.mode & 0o077) === 0, "CURRENT_Q1_CLEANUP_FAILED");
}

export async function closeCurrentQ1BindingScratch({ vite, cacheRoot, cacheIdentity }) {
  try { await vite?.close(); } finally {
    if (cacheRoot && cacheIdentity) {
      const after = await lstat(cacheRoot);
      assertCurrentQ1BindingScratchIdentity(cacheIdentity, after);
      await rm(cacheRoot, { recursive: true });
    }
  }
}

export function finishCurrentQ1ReferenceBindingCapture({ before, after, binding }) {
  requireFact(isDeepStrictEqual(before, after) && object(binding), "CURRENT_Q1_SOURCE_CHANGED");
  return freezeTree(binding);
}

/** Independently capture source, runtime, corpus, and canonical admission
 * identities before any database execution. A temporary Vite facade exposes
 * only the current public builders; its module graph is closed before return.
 * Raw synthetic rows remain in memory and never enter the binding object. */
export async function captureCurrentQ1ReferenceBinding() {
  const runtime = await measuredRuntime(), source = await sourceSnapshot(), corpusBefore = await corpusInput(null);
  const migrations = orderedMigrationInputs(source.files);
  const captureBoundaryBefore = { runtime, source, corpus: corpusBefore.provenance, migrations, bounds: BOUNDS };
  let vite, cacheRoot, cacheIdentity;
  let corpusStructure;
  try {
    cacheRoot = await mkdtemp(join(tmpdir(), "tibotattle-current-q1-binding-vite-"));
    cacheIdentity = await lstat(cacheRoot);
    requireFact(cacheIdentity.isDirectory() && !cacheIdentity.isSymbolicLink() && cacheIdentity.uid === process.getuid()
      && (cacheIdentity.mode & 0o077) === 0, "CURRENT_Q1_SCRATCH_INVALID");
    await chmod(cacheRoot, 0o700);
    const { createServer } = await import("vite");
    vite = await createServer({ root: WORKER_ROOT, cacheDir: cacheRoot, configFile: false, appType: "custom", logLevel: "silent",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    const P = await loadCurrent(vite), corpus = await corpusInput(P);
    requireFact(isDeepStrictEqual(corpusBefore.provenance, corpus.provenance), "CURRENT_Q1_CORPUS_INVALID");
    const admissionIdentities = await buildCurrentQ1AdmissionIdentities(P, corpus);
    corpusStructure = capturedCorpusStructure(corpus, admissionIdentities);
    requireFact(validCorpusStructure(corpusStructure), "CURRENT_Q1_CORPUS_INVALID");
  } finally {
    await closeCurrentQ1BindingScratch({ vite, cacheRoot, cacheIdentity });
  }
  const [runtimeAfter, sourceAfter, corpusAfter] = await Promise.all([
    measuredRuntime(), sourceSnapshot(), corpusInput(null),
  ]);
  const migrationsAfter = orderedMigrationInputs(sourceAfter.files);
  const binding = { schemaVersion: "current-q1-d1-reference-binding-v3", sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID,
    sourceNamespace: NAMESPACE, source, migrations, migrationSha256: jsonSha(migrations), runtime, bounds: BOUNDS,
    runtimeContracts: { v1: 1, v11: 1 }, corpus: corpusBefore.provenance, corpusStructure };
  const captureBoundaryAfter = { runtime: runtimeAfter, source: sourceAfter, corpus: corpusAfter.provenance,
    migrations: migrationsAfter, bounds: BOUNDS };
  return finishCurrentQ1ReferenceBindingCapture({ before: captureBoundaryBefore, after: captureBoundaryAfter, binding });
}

function validFilePins(value, ordered = false) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) return false;
  const paths = new Set(); let previous = "";
  for (const entry of value) {
    if (!exactKeys(entry, ["path", "sha256"]) || !safeSourcePath(entry.path) || !SHA256.test(entry.sha256)
      || paths.has(entry.path) || (ordered && entry.path <= previous)) return false;
    paths.add(entry.path); previous = entry.path;
  }
  return true;
}

function validSourcePin(value) {
  return exactKeys(value, ["head", "files", "sha256"]) && /^[a-f0-9]{40}$/u.test(value.head)
    && validFilePins(value.files, true) && value.sha256 === jsonSha(value.files);
}

function validBounds(value) {
  return exactKeys(value, Object.keys(BOUNDS)) && isDeepStrictEqual(value, BOUNDS);
}

function admissionCoordinate(participantId, format, day) {
  return JSON.stringify([participantId, format, day]);
}

function expectedAdmissionCoordinates(corpus) {
  const entries = [];
  const allDays = Array.from({ length: corpus.window.days }, (_, n) =>
    new Date(Date.parse(corpus.window.fromDay) + n * DAY_MS).toISOString().slice(0, 10));
  for (const owner of corpus.owners) {
    const format = owner.key === "c" ? "v12" : "v11";
    for (const day of allDays) entries.push(admissionCoordinate(owner.participantId, format, day));
  }
  for (const extra of corpus.v1ExtraAdmissions.entries) {
    entries.push(admissionCoordinate(extra.participantId, "v1", extra.day));
  }
  return entries.sort();
}

const ADMISSION_STREAMS = new Set(STREAMS);

/** Require every admission to match the complete canonical identity independently
 * derived before any admission code ran, not only its corpus coordinate or self-hash. */
export function validateCurrentQ1Admissions(admissions, corpus) {
  const code = "CURRENT_Q1_REFERENCE_BINDING_INVALID";
  try {
    requireFact(validCorpusStructure(corpus) && Array.isArray(admissions) && admissions.length === 682, code);
    const expected = new Map(corpus.admissionIdentities.map((entry) =>
      [admissionCoordinate(entry.participantId, entry.format, entry.day), entry]));
    const seen = new Set();
    for (const entry of admissions) {
      requireFact(object(entry) && typeof entry.participantId === "string" && DAY.test(entry.day), code);
      const coordinate = admissionCoordinate(entry.participantId, entry.format, entry.day);
      requireFact(expected.has(coordinate) && isDeepStrictEqual(entry, expected.get(coordinate)) && !seen.has(coordinate), code);
      seen.add(coordinate);
    }
    requireFact(isDeepStrictEqual([...seen].sort(), expectedAdmissionCoordinates(corpus)), code);
    return { count: admissions.length, sha256: jsonSha(admissions) };
  } catch { throw Object.assign(new Error(code), { code }); }
}

/** No fallback from reference output to an expectation. The owner supplies an
 * independently frozen capture, and every required provenance field is exact. */
export function validateCurrentQ1ReferenceBinding({ reference, expected }) {
  const code = "CURRENT_Q1_REFERENCE_BINDING_INVALID";
  try {
    requireFact(exactKeys(expected, ["schemaVersion", "sourceId", "sourceNamespace", "source", "migrations",
      "migrationSha256", "runtime", "bounds", "runtimeContracts", "corpus", "corpusStructure"])
      && expected.schemaVersion === "current-q1-d1-reference-binding-v3"
      && reference?.schemaVersion === "current-q1-d1-reference-v2" && reference.synthetic === true
      && validBounds(expected.bounds) && validBounds(reference.bounds)
      && reference.sourceId === CURRENT_Q1_REFERENCE_SOURCE_ID && reference.sourceNamespace === NAMESPACE
      && expected.sourceId === reference.sourceId && expected.sourceNamespace === reference.sourceNamespace, code);
    const actual = reference.provenance;
    requireFact(exactKeys(actual, ["source", "runtime", "corpus", "migrations", "migrationSha256",
      "runtimeContracts", "admissions", "admissionSha256", "cohort"])
      && validSourcePin(expected.source) && validSourcePin(actual.source)
      && isDeepStrictEqual(actual.source, expected.source), code);
    requireFact(exactKeys(expected.runtimeContracts, ["v1", "v11"]) && expected.runtimeContracts.v1 === 1
      && expected.runtimeContracts.v11 === 1 && exactKeys(actual.runtimeContracts, ["v1", "v11"])
      && isDeepStrictEqual(actual.runtimeContracts, expected.runtimeContracts), code);
    for (const candidate of [expected, actual]) {
      requireFact(validFilePins(candidate.migrations) && candidate.migrationSha256 === jsonSha(candidate.migrations)
        && isDeepStrictEqual(candidate.migrations, orderedMigrationInputs(candidate.source.files)), code);
      requireFact(exactKeys(candidate.runtime, ["version", "platform", "arch", "binarySha256", "pinnedNowMs", "randomSeed", "sqliteVersion"])
        && candidate.runtime.pinnedNowMs === CURRENT_Q1_REFERENCE_NOW_MS && candidate.runtime.randomSeed === "current-q1-reference"
        && typeof candidate.runtime.sqliteVersion === "string" && candidate.runtime.sqliteVersion.length > 0, code);
      assertCurrentQ1TrustedRuntime(candidate.runtime);
      requireFact(exactKeys(candidate.corpus, ["synthetic", "sourceCommit", "canonicalSha256", "recordCount", "primaryRecordCount",
        "owners", "daysPerOwner", "files"]) && candidate.corpus.synthetic === true && candidate.corpus.sourceCommit === CORPUS_SOURCE
        && candidate.corpus.canonicalSha256 === CORPUS_SHA && candidate.corpus.recordCount === 14_832
        && candidate.corpus.primaryRecordCount === 14_830 && candidate.corpus.owners === 4 && candidate.corpus.daysPerOwner === 170
        && validFilePins(candidate.corpus.files) && candidate.corpus.files.length === 5, code);
    }
    requireFact(isDeepStrictEqual(actual.migrations, expected.migrations) && actual.migrationSha256 === expected.migrationSha256
      && isDeepStrictEqual(actual.runtime, expected.runtime) && isDeepStrictEqual(actual.corpus, expected.corpus), code);
    requireFact(validCorpusStructure(expected.corpusStructure), code);
    validateCurrentQ1Admissions(actual.admissions, expected.corpusStructure);
    requireFact(SHA256.test(actual.admissionSha256) && actual.admissionSha256 === jsonSha(actual.admissions), code);
    const expectedCohort = expected.corpusStructure.owners.map((owner) =>
      ({ participantId: owner.participantId, ownerDigest: owner.pinnedOwnerDigest }))
      .sort((left, right) => left.participantId < right.participantId ? -1 : left.participantId > right.participantId ? 1 : 0);
    requireFact(Array.isArray(actual.cohort) && actual.cohort.length === 4 && actual.cohort.every((owner) =>
      exactKeys(owner, ["participantId", "ownerDigest"]) && SHA256.test(owner.ownerDigest))
      && isDeepStrictEqual([...actual.cohort].sort((left, right) => left.participantId < right.participantId ? -1
        : left.participantId > right.participantId ? 1 : 0), expectedCohort), code);
    return { state: "bound", sourceHead: expected.source.head, sourceSha256: expected.source.sha256,
      migrationSha256: expected.migrationSha256, corpusSha256: expected.corpus.canonicalSha256 };
  } catch { throw Object.assign(new Error(code), { code }); }
}

/** Reversible host facilities only; no product budget or SQLite tuning change. */
function pinRuntime(DatabaseSync) {
  requireFact(typeof DatabaseSync.prototype.setAuthorizer === "function", "CURRENT_Q1_RUNTIME_UNSUPPORTED");
  const original = { Date: globalThis.Date, randomUUID: crypto.randomUUID, randomValues: crypto.getRandomValues,
    random: Math.random, timingSafeEqual: Object.getOwnPropertyDescriptor(crypto.subtle, "timingSafeEqual"),
    setAuthorizer: DatabaseSync.prototype.setAuthorizer };
  let counter = 0, offset = 0, block = Buffer.alloc(0);
  const fill = (target) => {
    for (let n = 0; n < target.length; n++) {
      if (offset >= block.length) { block = createHash("sha256").update(`current-q1-reference\0${counter++}`).digest(); offset = 0; }
      target[n] = block[offset++];
    }
    return target;
  };
  function FixedDate(...args) {
    if (!new.target) return new original.Date(CURRENT_Q1_REFERENCE_NOW_MS).toString();
    return Reflect.construct(original.Date, args.length ? args : [CURRENT_Q1_REFERENCE_NOW_MS], new.target);
  }
  Object.setPrototypeOf(FixedDate, original.Date); FixedDate.prototype = original.Date.prototype;
  FixedDate.now = () => CURRENT_Q1_REFERENCE_NOW_MS;
  globalThis.Date = FixedDate;
  crypto.getRandomValues = (target) => {
    requireFact(ArrayBuffer.isView(target) && !(target instanceof DataView)
      && !(target instanceof Float32Array) && !(target instanceof Float64Array), "CURRENT_Q1_INPUT_INVALID");
    fill(new Uint8Array(target.buffer, target.byteOffset, target.byteLength)); return target;
  };
  crypto.randomUUID = () => {
    const bytes = fill(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = Buffer.from(bytes).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  Math.random = () => Number(Buffer.from(fill(new Uint8Array(8))).readBigUInt64BE() >> 11n) / 2 ** 53;
  crypto.subtle.timingSafeEqual = (left, right) => {
    const view = (value) => value instanceof ArrayBuffer ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return timingSafeEqual(view(left), view(right));
  };
  DatabaseSync.prototype.setAuthorizer = function fixedRandomAuthorizer(callback) {
    this.function("randomblob", { useBigIntArguments: true }, (length) => {
      const size = Number(length ?? 0);
      requireFact(Number.isSafeInteger(size) && size >= 0 && size <= 1_048_576, "CURRENT_Q1_INPUT_INVALID");
      return fill(new Uint8Array(Math.max(1, size)));
    });
    this.function("random", {}, () => Buffer.from(fill(new Uint8Array(8))).readBigInt64LE());
    return original.setAuthorizer.call(this, callback);
  };
  return () => {
    globalThis.Date = original.Date; crypto.randomUUID = original.randomUUID;
    crypto.getRandomValues = original.randomValues; Math.random = original.random;
    DatabaseSync.prototype.setAuthorizer = original.setAuthorizer;
    if (original.timingSafeEqual) Object.defineProperty(crypto.subtle, "timingSafeEqual", original.timingSafeEqual);
    else delete crypto.subtle.timingSafeEqual;
  };
}

/** Reuse only the existing reversible synthetic runtime adapter. */
export function pinCurrentQ1Runtime(DatabaseSync) {
  return pinRuntime(DatabaseSync);
}

function validateCorpusRecord(parser, stream, record) {
  const candidate = structuredClone(record), before = jsonSha(candidate);
  parser(stream, candidate);
  requireFact(jsonSha(candidate) === before, "CURRENT_Q1_CORPUS_INVALID");
}

async function loadCurrent(vite) {
  const P = {};
  for (const path of ["/test/helpers/telemetry-v11.ts", "/src/index.ts", "/src/canonical-json.ts", "/src/crypto.ts",
    "/src/device-auth.ts", "/src/accountless-enrollment.ts", "/src/accountless-ownership.ts",
    "/src/analytics-delivery.ts", "/src/community-daily-aggregates.ts", "/src/typed-v1-admission.ts",
    "/src/typed-v11-admission.ts", "/src/telemetry-v1.ts", "/src/telemetry-v1-repository.ts",
    "/src/telemetry-v11-domain.ts", "/src/telemetry-v11-repository.ts", "/src/telemetry-v12-domain.ts",
    "/src/telemetry-v12-repository.ts", "/src/telemetry-transport-policy.ts", "/src/storage-analytics-runtime.ts",
    "/src/storage-community-daily.ts", "/src/cache-retention-day.ts", "/src/d1-analytics-export-oracle.ts",
    "/src/storage-community-graph.ts", "/src/storage-community-authority.ts", "/src/storage-history-checkpoint.ts",
    "/src/storage-community-graph-publication.ts", "/src/storage-analytics-failure.ts",
    "/src/admin-community-allowance.ts", "/src/public-allowance-breakdowns.ts", "/src/community-daily-spend.ts",
    "/src/analytics-v2/public-allowance-breakdowns-v15.ts", "/src/analytics-v2/public-model-metadata-current.ts",
    "/src/errors.ts", "/src/quarantine-reconciliation.ts", "/src/analytics-history-proof.ts",
    "/src/collection-controls.ts", "/src/admin-operations.ts", "/src/telemetry-usage-effective-reader.ts",
    "/src/storage-community-graph-work.ts"]) {
    Object.assign(P, await vite.ssrLoadModule(path));
  }
  Object.assign(P, await vite.ssrLoadModule("/node_modules/@app-usagemonitor/telemetry-contract/index.js"));
  Object.assign(P, await vite.ssrLoadModule("/src/community-allowance.ts"));
  requireFact(REQUIRED_FUNCTIONS.every((name) => typeof P[name] === "function")
    && Array.isArray(P.STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS)
    && [P.STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD, P.STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD,
      P.STORAGE_GRAPH_EFFECTIVE_FITS_CHECKPOINT_METHOD, P.STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD]
      .every((method) => typeof method === "string" && P.STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS.includes(method)),
  "CURRENT_Q1_INPUT_INVALID");
  return P;
}

/** Load the same reviewed current production facades as the D1 producer. */
export async function loadCurrentQ1WorkerModules(vite) {
  return loadCurrent(vite);
}

/** Diagnostics retain only closed operation names and bounded ordinals/counts.
 * Wrappers forward each exact argument vector and preserve sync/async returns;
 * they never examine a record, identity, credential, SQL text or error message. */
function admissionDiagnostic(P) {
  const counts = Object.fromEntries(ADMISSION_OPERATIONS.map((operation) => [operation, 0]));
  const progress = { ownerOrdinal: 0, dayOrdinal: 0, chunkOrdinal: 0,
    completedOwners: 0, completedDays: 0, completedChunks: 0 };
  let operation = "none", failure = null;
  const snapshot = (error) => {
    if (failure) return failure;
    const type = error instanceof P.ApiError ? "api_error" : error instanceof TypeError ? "type_error"
      : error instanceof Error && ADMISSION_SQLITE_CODES.has(error.code) ? "sqlite_error"
        : error instanceof Error ? "error" : "non_error";
    const code = type === "api_error" && ADMISSION_API_CODES.has(error.code) ? error.code
      : type === "sqlite_error" ? error.code : "unclassified";
    failure = Object.freeze({ operation, type, code, ...progress, completedOperations: Object.freeze({ ...counts }) });
    return failure;
  };
  const run = (name, execute) => {
    requireFact(ADMISSION_OPERATIONS.includes(name), "CURRENT_Q1_INPUT_INVALID");
    operation = name;
    try {
      const result = execute();
      if (result instanceof Promise) return result.then((value) => { counts[name]++; return value; },
        (error) => { snapshot(error); throw error; });
      counts[name]++; return result;
    } catch (error) { snapshot(error); throw error; }
  };
  const functions = new Set(ADMISSION_FUNCTIONS), wrappers = new Map();
  const api = new Proxy(P, { get(target, property) {
    const value = Reflect.get(target, property);
    if (!functions.has(property)) return value;
    if (!wrappers.has(property)) wrappers.set(property, (...args) => run(property, () => Reflect.apply(value, target, args)));
    return wrappers.get(property);
  } });
  return { api, run, progress, snapshot };
}

/** Reuse the existing closed admission-operation diagnostics for another
 * current-source synthetic producer without changing the D1 runner policy. */
export function createCurrentQ1AdmissionDiagnostic(P) {
  return admissionDiagnostic(P);
}

function inertObjectStore() {
  const objects = new Map();
  return {
    async put(key, value) { objects.set(key, typeof value === "string" ? value.length : 0); return { key }; },
    async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
    async head(key) { return objects.has(key) ? { key } : null; },
    async get() { return null; },
    async list() { return { objects: [], truncated: false }; },
  };
}

/** Reuse the content-free in-memory quarantine adapter for versioned current
 * producers. The returned map remains scoped to the caller's fresh case. */
export function createCurrentQ1InertObjectStore() {
  return inertObjectStore();
}

async function applyMigrations(database, directory, provenance) {
  await database.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  const names = (await readdir(join(WORKER_ROOT, directory)))
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
  requireFact(names.length > 0, "CURRENT_Q1_MIGRATION_FAILED");
  for (const name of names) {
    const bytes = await boundedFile(join(WORKER_ROOT, directory, name));
    try {
      await database.exec(`BEGIN IMMEDIATE;\n${bytes.toString("utf8")}\n;INSERT INTO d1_migrations(name) VALUES('${name}');\nCOMMIT;`);
    } catch {
      await database.exec("ROLLBACK").catch(() => {});
      throw Object.assign(new Error("CURRENT_Q1_MIGRATION_FAILED"), { code: "CURRENT_Q1_MIGRATION_FAILED" });
    }
    provenance.push({ path: `apps/worker/${directory}/${name}`, sha256: sha(bytes) });
  }
}

/** Apply a current Worker migration set and retain its existing provenance. */
export async function applyCurrentQ1Migrations(database, directory, provenance) {
  return applyMigrations(database, directory, provenance);
}

async function seedCorpus(ctx, owners) {
  const { ingestion } = ctx, diagnostic = ctx.admissionDiagnostic, P = diagnostic.api;
  const admissions = [];
  const digest = (label) => P.sha256Hex(`gcp-fastpath-oracle:${label}`);
  const coordinates = async (principal, label) => {
    const envelopeDigest = await digest(`envelope:${label}`);
    const device = await P.authenticateDevice(ingestion, principal.authorization);
    const grant = await P.createDeviceUploadAuthorization(ingestion, device, envelopeDigest, 4_096);
    const claimed = await P.claimDeviceUploadAuthorization(ingestion, `Upload ${grant.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 4_096, contentType: "application/json" });
    return { envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
      chunkRowId: `chunk:${(await digest(`chunk:${label}`)).slice(0, 36)}`,
      r2Key: `synthetic-oracle-${(await digest(`r2:${label}`)).slice(0, 40)}` };
  };
  const pinOwner = async (owner) => diagnostic.run("owner_link_write", () =>
    ingestion.prepare(`INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
    VALUES(?,?,'active') ON CONFLICT(participant_id) DO NOTHING`).bind(owner.participantId, owner.pinnedOwnerDigest).run());
  const accountless = async (owner) => {
    const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
    const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
    const input = new Uint8Array(prefix.length + secret.length); input.set(prefix); input.set(secret, prefix.length);
    const deviceSecretHash = await P.sha256Hex(input);
    const authorization = `Device um_device_${deviceId}.${P.encodeBase64Url(secret)}`;
    input.fill(0); secret.fill(0);
    await P.enrollAccountlessDevice(ingestion, P.parseAccountlessEnrollmentRequest({
      schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
      policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" }));
    const randomUUID = crypto.randomUUID;
    let draws = 0;
    // Current ownership's sole UUID draw is the new participant. No stack
    // inspection, SQL identity rewrite, or historical participant restoration.
    crypto.randomUUID = () => { draws++; return owner.participantId.slice("participant:".length); };
    try {
      await P.createAccountlessUploadOwner(ingestion, authorization, P.parseAccountlessOwnershipRequest({
        schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
        authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }));
    } finally { crypto.randomUUID = randomUUID; }
    requireFact(draws === 1 && await diagnostic.run("accountless_owner_read", () =>
      ingestion.prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
        .bind(deviceId).first("participant_id")) === owner.participantId, "CURRENT_Q1_ADMISSION_FAILED");
    return { participantId: owner.participantId, deviceId, authorization };
  };
  const stageV11 = async (principal, days) => {
    const ready = [];
    for (const [dayIndex, { day, records }] of days.entries()) {
      diagnostic.progress.dayOrdinal = dayIndex + 1; diagnostic.progress.chunkOrdinal = 0;
      ctx.progress.counts(diagnostic.progress);
      const prepared = await prepareCurrentQ1V11Day(P, day, records);
      await P.registerTelemetryV11DayManifest(ingestion, principal, prepared.manifest);
      for (const [chunkIndex, chunk] of prepared.chunks.entries()) {
        diagnostic.progress.chunkOrdinal = chunkIndex + 1; ctx.progress.counts(diagnostic.progress);
        await P.persistTypedV11StagedChunk(ingestion, principal, chunk,
          { sourceNamespace: NAMESPACE, ...await coordinates(principal,
            `v11:${principal.participantId}:${day}:${chunk.chunkId}:${chunk.manifestDigest}`) });
        diagnostic.progress.completedChunks++; ctx.progress.counts(diagnostic.progress);
      }
      ready.push(await P.registerTelemetryV11DayManifest(ingestion, principal, prepared.manifest));
      admissions.push(currentQ1PrimaryAdmission(principal.participantId, "v11", day, prepared));
      diagnostic.progress.completedDays++; ctx.progress.counts(diagnostic.progress);
    }
    const predecessor = await P.createTelemetryV11DomainPredecessor(ingestion, principal, CURRENT_Q1_REFERENCE_NOW_MS);
    const domain = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: ready[0].day,
      throughDay: ready.at(-1).day, predecessor: { token: predecessor.token,
        previousGenerationId: predecessor.previousGenerationId, legacyFingerprint: predecessor.legacyFingerprint },
      days: ready.map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest })), manifestDigest: "0".repeat(64) };
    domain.manifestDigest = await P.sha256Hex(P.telemetryV11DomainManifestDigestInput(domain));
    await P.activateTelemetryV11Domain(ingestion, principal, domain, CURRENT_Q1_REFERENCE_NOW_MS);
  };
  const stageV12 = async (principal, days) => {
    const ready = [];
    for (const [dayIndex, { day, records }] of days.entries()) {
      diagnostic.progress.dayOrdinal = dayIndex + 1; diagnostic.progress.chunkOrdinal = 0;
      ctx.progress.counts(diagnostic.progress);
      const prepared = await prepareCurrentQ1V12Day(P, day, records), { chunks, manifest } = prepared;
      await P.registerTelemetryV12DayManifest(ingestion, principal, manifest);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        diagnostic.progress.chunkOrdinal = chunkIndex + 1; ctx.progress.counts(diagnostic.progress);
        P.parseTelemetryV12Chunk(chunk);
        const metadata = await coordinates(principal,
          `v12:${principal.participantId}:${day}:${chunk.chunkId}:${manifest.manifestDigest}`);
        metadata.r2Key = `telemetry/v12-export/${metadata.r2Key.slice("synthetic-oracle-".length)}`;
        await P.putTrackedQuarantineObject(ingestion, ctx.objects, { contributionId: metadata.chunkRowId,
          objectKind: "telemetry", r2Key: metadata.r2Key, registeredAt: new Date().toISOString() }, "synthetic v1.2 bytes");
        await P.persistTelemetryV12StagedChunk(ingestion, principal, chunk, metadata);
        diagnostic.progress.completedChunks++; ctx.progress.counts(diagnostic.progress);
      }
      ready.push(await P.registerTelemetryV12DayManifest(ingestion, principal, manifest));
      admissions.push(currentQ1PrimaryAdmission(principal.participantId, "v12", day, prepared));
      diagnostic.progress.completedDays++; ctx.progress.counts(diagnostic.progress);
    }
    const predecessor = await P.createTelemetryV12DomainPredecessor(ingestion, principal, CURRENT_Q1_REFERENCE_NOW_MS);
    const domain = { schemaVersion: "telemetry-domain-manifest-v1.2", fromDay: ready[0].day, throughDay: ready.at(-1).day,
      predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
        legacyFingerprint: predecessor.legacyFingerprint },
      days: ready.map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest })), manifestDigest: "0".repeat(64) };
    domain.manifestDigest = await P.sha256Hex(P.telemetryV12DomainManifestDigestInput(domain));
    await P.activateTelemetryV12Domain(ingestion, principal, domain, CURRENT_Q1_REFERENCE_NOW_MS);
  };
  const insertV1 = async (principal, days) => {
    for (const [dayIndex, { day, records }] of days.entries()) {
      diagnostic.progress.dayOrdinal = dayIndex + 1; diagnostic.progress.chunkOrdinal = 0;
      ctx.progress.counts(diagnostic.progress);
      for (const { stream, seq, chunk, admission } of await prepareCurrentQ1V1Chunks(P,
        principal.participantId, day, records)) {
        diagnostic.progress.chunkOrdinal++; ctx.progress.counts(diagnostic.progress);
        requireFact(await P.currentTelemetryV1Chunk(ingestion, principal.participantId, principal.deviceId, stream, day, seq) === null,
          "CURRENT_Q1_ADMISSION_FAILED");
        await P.insertTypedTelemetryV1Chunk(ingestion, { participantId: principal.participantId, deviceId: principal.deviceId, chunk,
          ...await coordinates(principal, `v1:${principal.participantId}:${day}:${stream}:${seq}`),
          createdAt: new Date().toISOString(), supersedes: null }, NAMESPACE);
        admissions.push(admission);
        diagnostic.progress.completedChunks++; ctx.progress.counts(diagnostic.progress);
      }
      diagnostic.progress.completedDays++; ctx.progress.counts(diagnostic.progress);
    }
  };
  for (const [ownerIndex, owner] of owners.entries()) {
    diagnostic.progress.ownerOrdinal = ownerIndex + 1;
    diagnostic.progress.dayOrdinal = 0; diagnostic.progress.chunkOrdinal = 0;
    ctx.progress.counts(diagnostic.progress);
    if (owner.kind === "accountless") {
      const principal = await accountless(owner); await pinOwner(owner); await stageV11(principal, owner.days);
    } else if (owner.key === "c") {
      const principal = await P.createV11DeviceFixture(ingestion, { participantId: owner.participantId });
      await pinOwner(owner); await P.grantTelemetryV12Consent(ingestion, principal, P.telemetryV12RequiredConsent());
      await stageV12(principal, owner.days);
    } else {
      const extras = owner.days.flatMap((day) => day.v1Extra ? [{ day: day.day, records: day.v1Extra }] : []);
      if (owner.key === "d") {
        const legacy = await P.createV11DeviceFixture(ingestion, { participantId: owner.participantId });
        await pinOwner(owner); await insertV1(legacy, extras);
      }
      const principal = await P.createV11DeviceFixture(ingestion, { participantId: owner.participantId, grant: true });
      await pinOwner(owner); await stageV11(principal, owner.days);
      if (owner.key === "a") await insertV1(await P.createV11DeviceFixture(ingestion,
        { participantId: owner.participantId }), extras);
    }
    diagnostic.progress.completedOwners++; ctx.progress.counts(diagnostic.progress);
  }
  return admissions;
}

/** Seed a separately generated current corpus through the same public routes. */
export async function seedCurrentQ1Corpus(ctx, owners) {
  return seedCorpus(ctx, owners);
}

/** Public source-invariant seams for independent current-source qualification. */
export async function captureCurrentQ1IngestionInvariant(database) {
  return captureCurrentQ1SourceInvariant(database);
}
export async function captureCurrentQ1IngestionInvariantDetails(database) {
  return captureCurrentQ1SourceInvariantDetails(database);
}

export function assertCurrentQ1IngestionInvariantUnchanged(before, after) {
  return assertCurrentQ1SourceUnchanged(before, after);
}

/** Keep the exact existing negative strict-export proof available to v3. */
export async function proveCurrentQ1ExportConflictRefusal(ctx, moduleDigest) {
  return proveCurrentQ1StrictExportRefusal(ctx, moduleDigest);
}

const bindings = (ctx) => ({ source: ctx.ingestion, target: ctx.analytics,
  sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID, sourceNamespace: NAMESPACE });

/** Construct the current D1 bindings without exposing a mutable policy knob. */
export function currentQ1DatabaseBindings(ctx) {
  return bindings(ctx);
}

async function settle(ctx, corpus) {
  ctx.progress.phase("settle_bootstrap");
  let bootstrap = false;
  for (let n = 0; n < BOUNDS.bootstrap; n++) if ((await ctx.P.drainCommunityPublicSourceBootstrap(ctx.ingestion)).completed) {
    bootstrap = true; break;
  }
  requireFact(bootstrap, "CURRENT_Q1_NOT_SETTLED");
  ctx.initialSource = await captureCurrentQ1SourceInvariant(ctx.ingestion);
  ctx.initialConflict = await conflictEvidence(ctx, corpus);
  let idle = false;
  ctx.progress.phase("settle_delivery");
  for (let n = 0; n < BOUNDS.delivery * BOUNDS.settleRounds; n++) {
    ctx.progress.counts({ iteration: n + 1 });
    const step = await ctx.P.advanceStorageAnalytics(bindings(ctx));
    if (step.state === "idle") { idle = true; break; }
    requireFact(["applied", "discarded", "building"].includes(step.state), "CURRENT_Q1_NOT_SETTLED");
  }
  requireFact(idle, "CURRENT_Q1_NOT_SETTLED");
  ctx.progress.phase("settle_daily");
  const dailyPasses = await runCurrentQ1DailyConvergence(ctx, corpus, BOUNDS.dailyConvergence);
  ctx.progress.phase("settle_retirement");
  for (let n = 0; n < BOUNDS.dailyRetirement; n++) if (await ctx.P.retireStorageCommunityDailyPage(bindings(ctx)) === 0) break;
  ctx.progress.phase("settle_cache");
  for (let n = 0; n < BOUNDS.cachePasses; n++) {
    ctx.progress.counts({ iteration: n + 1 });
    const step = await advanceCurrentQ1CachePass(ctx);
    if (step.state === "idle") return dailyPasses;
  }
  throw Object.assign(new Error("CURRENT_Q1_NOT_SETTLED"), { code: "CURRENT_Q1_NOT_SETTLED" });
}

async function conflictEvidence(ctx, corpus) {
  const expected = corpus.owners.find((owner) => owner.key === "a");
  const owner = (await ctx.P.readStorageCommunityOwnerPage(ctx.ingestion, { limit: 5 }))
    .find((candidate) => candidate.ownerDigest === expected.pinnedOwnerDigest);
  requireFact(owner?.participantId === expected.participantId, "CURRENT_Q1_ADMISSION_FAILED");
  const evidence = [];
  for (const day of corpus.conflictDays) {
    const hash = createHash("sha256"); let rows = 0, conflictRows = 0;
    for (const stream of STREAMS) {
      let after;
      for (let n = 0; n < 256; n++) {
        const page = await ctx.P.readEffectiveTelemetryOwnerDayPage(ctx.ingestion, {
          sourceNamespace: NAMESPACE, ownerDigest: owner.ownerDigest, ownerRevision: owner.ownerRevision,
          authorityEpoch: owner.authorityEpoch, day, stream, limit: 50, ...(after === undefined ? {} : { after }),
        });
        requireFact(Array.isArray(page.rows) && page.rows.length <= 50, "CURRENT_Q1_NOT_SETTLED");
        for (const row of page.rows) {
          rows++; conflictRows += row.status === "conflict" ? 1 : 0;
          hash.update(jsonSha(row)).update("\n");
        }
        if (page.next === null) break;
        requireFact(n < 255 && !isDeepStrictEqual(after, page.next), "CURRENT_Q1_NOT_SETTLED"); after = page.next;
      }
    }
    requireFact(conflictRows === 1, "CURRENT_Q1_NOT_SETTLED");
    evidence.push({ day, rows, conflictRows, sha256: hash.digest("hex") });
  }
  return evidence;
}

/** Capture current canonical effective-reader conflict evidence for v3. */
export async function captureCurrentQ1ConflictEvidence(ctx, corpus) {
  return conflictEvidence(ctx, corpus);
}

async function convergenceSnapshot(ctx, corpus, dailyPasses, admissions) {
  const authority = await ctx.P.captureStorageCommunityAuthority(ctx.ingestion, bindings(ctx));
  const journalMax = await ctx.ingestion.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM storage_ingestion_changes").first("n");
  const cursorSequence = await ctx.analytics.prepare("SELECT sequence FROM analytics_source_cursors WHERE source_id=?")
    .bind(ctx.sourceId).first("sequence");
  const delivery = await ctx.P.advanceStorageAnalytics(bindings(ctx));
  requireFact(delivery.state === "idle" && delivery.sequence === journalMax && cursorSequence === journalMax,
    "CURRENT_Q1_NOT_SETTLED");
  const retainedQueue = (await ctx.analytics.prepare("SELECT source_id,day,revision FROM analytics_community_daily_queue ORDER BY source_id,day").all()).results;
  requireFact(retainedQueue.every((row) => row.source_id === ctx.sourceId), "CURRENT_Q1_NOT_SETTLED");
  const selection = await ctx.P.readD1AnalyticsImportSelection({ ...bindings(ctx), pinnedNowMs: ctx.nowMs });
  requireFact(isDeepStrictEqual(selection.heads.map((row) => row.day), corpus.expectedDailyDays)
    && isDeepStrictEqual(selection.daily.map((row) => row.day), corpus.expectedDailyDays), "CURRENT_Q1_NOT_SETTLED");
  const filtered = await ctx.P.advanceNextStorageCommunityDaily({ ...bindings(ctx), nowMs: ctx.nowMs, skipDays: corpus.conflictDays });
  const unfiltered = await ctx.P.advanceNextStorageCommunityDaily({ ...bindings(ctx), nowMs: ctx.nowMs });
  requireFact(isDeepStrictEqual(filtered, { state: "idle", ownersAdvanced: 0 }), "CURRENT_Q1_NOT_SETTLED");
  const cache = await advanceCurrentQ1CachePass(ctx);
  requireFact(cache.state === "idle", "CURRENT_Q1_NOT_SETTLED");
  const currentSource = await captureCurrentQ1SourceInvariant(ctx.ingestion);
  assertCurrentQ1SourceUnchanged(ctx.expectedSource, currentSource);
  const retainedConflict = await conflictEvidence(ctx, corpus);
  requireFact(isDeepStrictEqual(ctx.initialConflict, retainedConflict), "CURRENT_Q1_NOT_SETTLED");
  return { publishedDays: selection.daily.map((row) => row.day), retainedQueue: retainedQueue.map(({ day, revision }) => ({ day, revision })),
    conflictEvidence: retainedConflict, admissionSha256: jsonSha(admissions),
    sourceInvariantSha256: currentSource.sha256, dailyPasses,
    fence: { authority, journalMax, cursorSequence, cursorReceipt: true,
      sourceTerminalEpoch: await ctx.P.readStorageCommunitySourceTerminalEpoch(ctx.ingestion),
      deliveredTerminalEpoch: await ctx.P.readStorageCommunityDeliveredTerminalEpoch(ctx.analytics, ctx.sourceId),
      pendingErasureJobs: await ctx.ledger.prepare("SELECT count(*) AS n FROM storage_erasure_jobs WHERE state='pending'").first("n"), cacheIdle: true },
    selector: { filteredIdle: true, unfiltered } };
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const TOTAL_KEYS = Object.freeze(["contributingParticipants", "contributingDevices", "usageEvents", "quotaObservations",
  "sessionDimensions", "inputUncachedTokens", "inputCacheReadTokens", "inputCacheWriteTokens", "outputTextTokens",
  "outputReasoningTokens", "outputCombinedTokens"]);
const TOKEN_KEYS = Object.freeze(TOTAL_KEYS.slice(5));
const CELL_KEYS = Object.freeze(["provider", "modelId", "usageEvents", ...TOKEN_KEYS]);
const SPEND_KEYS = Object.freeze(["basis", "currency", "knownCostUsd", "coverage", "usageEvents", "fullyPricedUsageEvents",
  "partiallyPricedUsageEvents", "unpricedUsageEvents", "pricingMethodVersion", "registrySha256"]);

function graphWindowDays() {
  const today = new Date(CURRENT_Q1_REFERENCE_NOW_MS).toISOString().slice(0, 10);
  return Array.from({ length: 70 }, (_, n) => new Date(Date.parse(today) - (69 - n) * DAY_MS).toISOString().slice(0, 10));
}

function validCorpusStructure(corpus) {
  if (!exactKeys(corpus, ["owners", "window", "expectedDailyDays", "conflictDays", "v1ExtraAdmissions", "admissionIdentities"])
    || !Array.isArray(corpus.owners)
    || corpus.owners.length !== 4 || !exactKeys(corpus.window, ["fromDay", "throughDay", "days"])
    || corpus.window.fromDay !== "2026-04-15" || corpus.window.throughDay !== "2026-10-01" || corpus.window.days !== 170
    || !Array.isArray(corpus.expectedDailyDays) || corpus.expectedDailyDays.length !== 168) return false;
  const keys = new Set(), participants = new Set(), digests = new Set();
  for (const owner of corpus.owners) {
    if (!exactKeys(owner, ["key", "participantId", "pinnedOwnerDigest", "models"]) || !["a", "b", "c", "d"].includes(owner.key)
      || keys.has(owner.key) || !/^participant:[a-f0-9-]{36}$/u.test(owner.participantId) || participants.has(owner.participantId)
      || !SHA256.test(owner.pinnedOwnerDigest) || digests.has(owner.pinnedOwnerDigest) || !Array.isArray(owner.models)
      || owner.models.length < 1 || owner.models.some((model) => typeof model !== "string" || model.length < 1 || model.length > 128)
      || new Set(owner.models).size !== owner.models.length) return false;
    keys.add(owner.key); participants.add(owner.participantId); digests.add(owner.pinnedOwnerDigest);
  }
  let previous = "";
  for (const day of corpus.expectedDailyDays) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || day <= previous || day < corpus.window.fromDay || day > corpus.window.throughDay) return false;
    previous = day;
  }
  if (!Array.isArray(corpus.conflictDays) || corpus.conflictDays.length !== 2) return false;
  const all = [...corpus.expectedDailyDays, ...corpus.conflictDays].sort();
  if (!all.every((day, n) => day === new Date(Date.parse(corpus.window.fromDay) + n * DAY_MS).toISOString().slice(0, 10))) return false;
  if (!(corpus.conflictDays[0] < corpus.conflictDays[1])) return false;
  const extras = corpus.v1ExtraAdmissions;
  if (!exactKeys(extras, ["count", "sha256", "entries"]) || extras.count !== 2 || !Array.isArray(extras.entries)
    || extras.entries.length !== extras.count || !SHA256.test(extras.sha256) || extras.sha256 !== jsonSha(extras.entries)) return false;
  const extraKeys = new Set(), extraCoordinates = new Set(); let previousExtra = "";
  for (const extra of extras.entries) {
    if (!exactKeys(extra, ["ownerKey", "participantId", "day", "format", "stream", "records", "corpusRowsSha256"])
      || !DAY.test(extra.day) || new Date(Date.parse(extra.day)).toISOString().slice(0, 10) !== extra.day
      || extra.day < corpus.window.fromDay || extra.day > corpus.window.throughDay
      || extra.format !== "v1" || !ADMISSION_STREAMS.has(extra.stream) || !count(extra.records) || extra.records < 1
      || !SHA256.test(extra.corpusRowsSha256)) return false;
    const owner = corpus.owners.find((candidate) => candidate.key === extra.ownerKey);
    const key = `${extra.ownerKey}\0${extra.day}\0${extra.stream}`;
    const coordinate = admissionCoordinate(extra.participantId, "v1", extra.day);
    if (!owner || owner.participantId !== extra.participantId || extraKeys.has(key) || extraCoordinates.has(coordinate)
      || key <= previousExtra) return false;
    extraKeys.add(key); previousExtra = key;
    extraCoordinates.add(coordinate);
  }
  const expectedCoordinates = expectedAdmissionCoordinates(corpus);
  if (!Array.isArray(corpus.admissionIdentities) || corpus.admissionIdentities.length !== expectedCoordinates.length) return false;
  const identityCoordinates = new Set(), actualCoordinates = [];
  for (const entry of corpus.admissionIdentities) {
    if (!object(entry) || typeof entry.participantId !== "string" || !DAY.test(entry.day)) return false;
    const owner = corpus.owners.find((candidate) => candidate.participantId === entry.participantId);
    if (!owner) return false;
    const coordinate = admissionCoordinate(entry.participantId, entry.format, entry.day);
    if (identityCoordinates.has(coordinate)) return false;
    identityCoordinates.add(coordinate); actualCoordinates.push(coordinate);
    if (entry.format === "v1") {
      const expected = extras.entries.find((candidate) =>
        admissionCoordinate(candidate.participantId, "v1", candidate.day) === coordinate);
      if (!expected || owner.key !== expected.ownerKey
        || !exactKeys(entry, ["participantId", "format", "day", "chunkDigest", "stream", "records", "corpusRowsSha256"])
        || !SHA256.test(entry.chunkDigest) || entry.stream !== expected.stream || entry.records !== expected.records
        || entry.corpusRowsSha256 !== expected.corpusRowsSha256) return false;
    } else {
      if (!exactKeys(entry, ["participantId", "format", "day", "manifestDigest", "chunks"])
        || entry.format !== (owner.key === "c" ? "v12" : "v11") || !SHA256.test(entry.manifestDigest)
        || !Array.isArray(entry.chunks) || entry.chunks.length < 1 || entry.chunks.length > 64) return false;
      const chunkIds = new Set();
      for (const chunk of entry.chunks) {
        if (!exactKeys(chunk, ["chunkId", "chunkDigest", "recordCount"])
          || typeof chunk.chunkId !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/u.test(chunk.chunkId)
          || chunkIds.has(chunk.chunkId) || !SHA256.test(chunk.chunkDigest) || !count(chunk.recordCount) || chunk.recordCount < 1) return false;
        chunkIds.add(chunk.chunkId);
      }
    }
  }
  return isDeepStrictEqual(actualCoordinates, expectedCoordinates);
}

/** Classification consumes only the result already verified by the production
 * reader. It never decodes a raw cache or substitutes for the reader's fences. */
export function classifyCurrentQ1VerifiedNativeOutcome({ metric, outcome, verified, knownNotTestableReasons }) {
  const unresolved = (reason) => ({ state: "unresolved", reason });
  if (!["fits", "model"].includes(metric) || !object(outcome) || outcome.state !== "complete") {
    return unresolved("computation_not_complete");
  }
  if (!object(verified)) return unresolved("verified_result_unavailable");
  if (!isDeepStrictEqual(outcome.result, verified)) return { ...unresolved("verified_result_mismatch"), computeOutcomeMatchesVerified: false };
  if (verified.scope?.metric !== metric || verified.unsupportedSource || typeof outcome.reused !== "boolean") {
    return unresolved("verified_result_not_qualifying");
  }
  const provenance = { computeOutcomeMatchesVerified: true, payloadSha256: jsonSha(verified), reused: outcome.reused };
  if (metric === "fits" && Array.isArray(verified.fits) && verified.composition === null) return { state: "complete", ...provenance };
  if (metric === "model" && verified.fits === null && object(verified.composition)) {
    if (verified.composition.status === "ready") return { state: "complete", ...provenance };
    if (verified.composition.status === "not_testable" && knownNotTestableReasons instanceof Set
      && knownNotTestableReasons.has(verified.composition.reason)) {
      return { state: "not_testable", reason: verified.composition.reason, ...provenance };
    }
  }
  return unresolved("verified_result_not_qualifying");
}

const COMPLETENESS_REASONS = Object.freeze(["recomputation_not_converged", "reference_schema_invalid", "corpus_convergence_invalid", "recomputation_invalid", "strict_export_refusal_invalid", "corpus_structure_invalid", "cohort_incomplete", "graph_dates_incomplete",
  "graph_publications_incomplete", "admission_coverage_invalid", "native_scope_set_incomplete", "native_result_unverified", "final_snapshot_incomplete"]);

const NATIVE_BASE_KEYS = Object.freeze(["owner", "metric", "day", "state", "invocations"]);
const NATIVE_FAILURE_REASONS = new Set(["d1_cpu_limit", "d1_timeout", "query_too_large", "too_many_bindings", "query_limit",
  "d1_other", "checkpoint_unavailable", "checkpoint_mismatch", "source_changed", "application"]);
const NATIVE_OPERATION_STAGES = new Set(["graph_scope", "graph_historical_pin", "graph_checkpoint_load", "graph_history_direct_read",
  "graph_history_layout", "graph_history_source_precheck", "graph_history_reader", "graph_history_acquisition_page",
  "graph_history_source_postcheck", "graph_history_finish", "graph_checkpoint_save", "graph_current_fit_compute",
  "graph_model_compute", "graph_prepared_days", "daily_publish", "graph_work"]);
const NATIVE_MODEL_REFUSALS = new Set(["supported_quota_track_unavailable", "plan_attribution_limit_exceeded",
  "multi_plan_window_unsupported", "multi_provider_window_unsupported", "downsampled_quota_limit_exceeded",
  "windowed_usage_limit_exceeded", "usage_cost_limit_exceeded", "multi_account_window_unsupported",
  "multi_era_window_unsupported", "continuity_track_limit_exceeded", "usage_day_limit_exceeded",
  "invalid_attribution_record", "session_interval_scope_limit_exceeded", "reduced_usage_limit_exceeded",
  "usage_attribution_unresolved"]);
const NATIVE_UNRESOLVED_REASONS = new Set([...NATIVE_FAILURE_REASONS, "deferred", "execution_failed",
  "computation_not_complete", "verified_result_unavailable", "verified_result_mismatch", "verified_result_not_qualifying"]);
const NATIVE_GRAPH_DAYS = new Set(graphWindowDays());

/** Validate the exact owner/metric/day set and the closed result union emitted
 * by bounded native probes. Unresolved and refused are valid evidence shapes,
 * but remain non-qualifying states for the outer completeness decision. */
export function validateCurrentQ1NativeEvidence(native, expectedScopes) {
  const code = "CURRENT_Q1_REFERENCE_BINDING_INVALID";
  try {
    requireFact(Array.isArray(native) && Array.isArray(expectedScopes), code);
    const scopeKey = ({ owner, metric, day }) => `${owner}\0${metric}\0${day}`;
    const expected = [], expectedSet = new Set();
    for (const scope of expectedScopes) {
      requireFact(exactKeys(scope, ["owner", "metric", "day"]) && ["a", "b", "c", "d"].includes(scope.owner)
        && ["fits", "model"].includes(scope.metric) && NATIVE_GRAPH_DAYS.has(scope.day), code);
      const key = scopeKey(scope);
      requireFact(!expectedSet.has(key), code); expectedSet.add(key); expected.push(key);
    }
    const actual = [], seen = new Set();
    for (const entry of native) {
      requireFact(object(entry) && ["a", "b", "c", "d"].includes(entry.owner)
        && ["fits", "model"].includes(entry.metric) && NATIVE_GRAPH_DAYS.has(entry.day)
        && count(entry.invocations) && entry.invocations <= BOUNDS.nativeInvocations, code);
      const key = scopeKey(entry);
      requireFact(!seen.has(key), code); seen.add(key); actual.push(key);
      if (entry.state === "complete") {
        requireFact(exactKeys(entry, [...NATIVE_BASE_KEYS, "computeOutcomeMatchesVerified", "payloadSha256", "reused"])
          && entry.invocations > 0 && entry.computeOutcomeMatchesVerified === true && SHA256.test(entry.payloadSha256)
          && typeof entry.reused === "boolean", code);
      } else if (entry.state === "not_testable") {
        requireFact(exactKeys(entry, [...NATIVE_BASE_KEYS, "reason", "computeOutcomeMatchesVerified", "payloadSha256", "reused"])
          && entry.metric === "model" && entry.invocations > 0 && NATIVE_MODEL_REFUSALS.has(entry.reason)
          && entry.computeOutcomeMatchesVerified === true && SHA256.test(entry.payloadSha256)
          && typeof entry.reused === "boolean", code);
      } else if (entry.state === "unresolved") {
        const allowed = new Set([...NATIVE_BASE_KEYS, "reason", "bound", "computeOutcomeMatchesVerified"]);
        requireFact(NATIVE_BASE_KEYS.every((field) => Object.hasOwn(entry, field))
          && Object.keys(entry).every((field) => allowed.has(field))
          && typeof entry.reason === "string" && NATIVE_UNRESOLVED_REASONS.has(entry.reason)
          && (!Object.hasOwn(entry, "bound") || ["stall", "invocations"].includes(entry.bound))
          && (!Object.hasOwn(entry, "computeOutcomeMatchesVerified")
            || entry.computeOutcomeMatchesVerified === false && entry.reason === "verified_result_mismatch")
          && (entry.reason !== "verified_result_mismatch" || entry.computeOutcomeMatchesVerified === false)
          && (entry.bound !== "invocations" || entry.invocations === BOUNDS.nativeInvocations), code);
      } else if (entry.state === "refused") {
        requireFact(exactKeys(entry, [...NATIVE_BASE_KEYS, "nativeCapacityRefusal", "reason", "phase"])
          && entry.nativeCapacityRefusal === false
          && (NATIVE_FAILURE_REASONS.has(entry.reason) || entry.reason === "application")
          && NATIVE_OPERATION_STAGES.has(entry.phase), code);
      } else requireFact(false, code);
    }
    requireFact(isDeepStrictEqual(actual.sort(), expected.sort()), code);
    return native;
  } catch { throw Object.assign(new Error(code), { code }); }
}

function readySnapshotShape(snapshot, readiness, corpus, graphDays) {
  const nowIso = new Date(CURRENT_Q1_REFERENCE_NOW_MS).toISOString(), publicDays = graphDays.slice(0, -1);
  if (!exactKeys(snapshot, ["publicResponse", "adminPreview", "readiness"])
    || !exactKeys(snapshot.publicResponse, ["status", "body"]) || snapshot.publicResponse.status !== 200
    || !exactKeys(readiness, ["state", "reasons", "expectedDailyDays", "expectedPreviewDays", "expectedPublicAllowanceDays"])
    || readiness.state !== "ready" || !isDeepStrictEqual(readiness.reasons, [])
    || !isDeepStrictEqual(snapshot.readiness, readiness) || !isDeepStrictEqual(readiness.expectedDailyDays, corpus.expectedDailyDays)
    || !isDeepStrictEqual(readiness.expectedPreviewDays, graphDays) || !isDeepStrictEqual(readiness.expectedPublicAllowanceDays, publicDays)) return false;
  const body = snapshot.publicResponse.body, preview = snapshot.adminPreview;
  if (!exactKeys(body, ["schemaVersion", "from", "to", "allowanceState", "allowanceReadState", "allowanceBreakdowns", "cacheRetention", "days"])
    || body.schemaVersion !== "community-daily-read-v1.0" || body.from !== corpus.window.fromDay || body.to !== corpus.window.throughDay
    || body.allowanceState !== "ready" || body.allowanceReadState !== "confirmed" || !Array.isArray(body.days)
    || !isDeepStrictEqual(body.days.map((day) => day?.day), corpus.expectedDailyDays)) return false;
  for (const day of body.days) {
    const payload = day?.payload;
    if (!exactKeys(day, ["day", "revision", "releasedAt", "payload"]) || !count(day.revision) || day.revision < 1 || day.releasedAt !== nowIso
      || !exactKeys(payload, ["schemaVersion", "aggregateId", "day", "revision", "releasedAt", "immutableRevision", "recomputesOnLateData",
        "policyVersion", "suppression", "apiEquivalentSpend", "totals", "cellsTruncated", "cells"])
      || payload.schemaVersion !== "community-daily-aggregate-v1.0" || payload.day !== day.day || payload.revision !== day.revision
      || payload.releasedAt !== nowIso || payload.aggregateId !== `community-daily:${day.day}:r${day.revision}`
      || payload.immutableRevision !== true || payload.recomputesOnLateData !== true || payload.cellsTruncated !== false
      || !exactKeys(payload.totals, TOTAL_KEYS) || TOTAL_KEYS.some((key) => !count(payload.totals[key]))
      || !Array.isArray(payload.cells) || !exactKeys(payload.apiEquivalentSpend, SPEND_KEYS)
      || payload.apiEquivalentSpend.usageEvents !== payload.totals.usageEvents
      || !(payload.apiEquivalentSpend.knownCostUsd === null || typeof payload.apiEquivalentSpend.knownCostUsd === "number"
        && Number.isFinite(payload.apiEquivalentSpend.knownCostUsd) && payload.apiEquivalentSpend.knownCostUsd >= 0)) return false;
    for (const cell of payload.cells) if (!exactKeys(cell, CELL_KEYS)
      || !["usageEvents", ...TOKEN_KEYS].every((key) => count(cell[key]))) return false;
  }
  if (!exactKeys(body.cacheRetention, ["schemaVersion", "metric", "methodVersion", "measures", "gapBasis", "windows"])
    || body.cacheRetention.schemaVersion !== "community-cache-retention-v1.0" || !Array.isArray(body.cacheRetention.windows)
    || body.cacheRetention.windows.length === 0) return false;
  if (!exactKeys(body.allowanceBreakdowns, ["schemaVersion", "basis", "referencePlanType", "normalization", "modelBasis", "modelGate",
    "generatedAt", "days", "modelConfig"]) || body.allowanceBreakdowns.schemaVersion !== "community-allowance-breakdowns-v1.5"
    || body.allowanceBreakdowns.generatedAt !== nowIso || !Array.isArray(body.allowanceBreakdowns.days)
    || !isDeepStrictEqual(body.allowanceBreakdowns.days.map((day) => day?.day), publicDays)
    || !Array.isArray(body.allowanceBreakdowns.modelConfig) || body.allowanceBreakdowns.modelConfig.length !== 7) return false;
  return exactKeys(preview, ["schemaVersion", "generatedAt", "from", "to", "basis", "referencePlanType", "trailingDays", "qualification",
    "spanFloorPp", "plans", "coverage", "days", "models"]) && preview.schemaVersion === "admin-community-allowance-preview-v0.5"
    && preview.generatedAt === nowIso && preview.from === graphDays[0] && preview.to === graphDays.at(-1)
    && Array.isArray(preview.days) && isDeepStrictEqual(preview.days.map((day) => day?.day), graphDays)
    && exactKeys(preview.models, ["modelConfig", "basis", "gate", "days"]) && Array.isArray(preview.models.modelConfig)
    && preview.models.modelConfig.length === 43 && Array.isArray(preview.models.days)
    && isDeepStrictEqual(preview.models.days.map((day) => day?.day), graphDays);
}

/** Completeness supplements the full actual D1 validators. Readiness booleans
 * cannot qualify empty/tampered DTOs, missing owners/dates or fabricated scopes. */
export function assessCurrentQ1ReferenceCompleteness({ reference, corpus, snapshotReadiness }) {
  const reasons = new Set(), fail = (reason) => reasons.add(reason);
  if (!validCorpusStructure(corpus)) return { state: "unresolved", reasons: ["corpus_structure_invalid"] };
  if (!exactKeys(reference, ["schemaVersion", "synthetic", "qualification", "sourceId", "sourceNamespace", "bounds",
    "provenance", "beforeForcedRecompute", "afterForcedRecompute", "afterNativeProbes", "recomputation",
    "corpusConvergence", "strictExportRefusal", "graphPublications", "nativeEvidence"])
    || reference.schemaVersion !== "current-q1-d1-reference-v2" || reference.synthetic !== true
    || !["complete", "unresolved"].includes(reference.qualification) || !validBounds(reference.bounds)
    || !exactKeys(reference.provenance, ["source", "runtime", "corpus", "migrations", "migrationSha256",
      "runtimeContracts", "admissions", "admissionSha256", "cohort"])
    || !exactKeys(reference.provenance.runtimeContracts, ["v1", "v11"])
    || !isDeepStrictEqual(reference.provenance.runtimeContracts, { v1: 1, v11: 1 })) fail("reference_schema_invalid");
  try {
    validateCurrentQ1Admissions(reference?.provenance?.admissions, corpus);
    requireFact(SHA256.test(reference.provenance.admissionSha256)
      && reference.provenance.admissionSha256 === jsonSha(reference.provenance.admissions), "CURRENT_Q1_NOT_SETTLED");
  } catch { fail("admission_coverage_invalid"); }
  try { validateCurrentQ1CorpusConvergence(reference?.corpusConvergence, corpus); } catch { fail("corpus_convergence_invalid"); }
  try { validateCurrentQ1Recomputation(reference?.recomputation, corpus); } catch { fail("recomputation_invalid"); }
  try { validateCurrentQ1StrictExportRefusal(reference?.strictExportRefusal); } catch { fail("strict_export_refusal_invalid"); }
  try {
    const convergence = reference.corpusConvergence, recomputation = reference.recomputation;
    requireFact(convergence.beforeRecompute.admissionSha256 === reference.provenance.admissionSha256
      && convergence.beforeRecompute.sourceInvariantSha256 === recomputation.sourceInvariantSha256.before
      && convergence.afterRecompute.sourceInvariantSha256 === recomputation.sourceInvariantSha256.after
      && recomputation.collectionRevision.before === convergence.beforeRecompute.fence.authority.collectionRevision
      && recomputation.collectionRevision.after === convergence.afterRecompute.fence.authority.collectionRevision
      && recomputation.invocations.daily === convergence.afterRecompute.dailyPasses.reduce((n, pass) => n + pass.iterations, 0)
      && convergence.beforeRecompute.fence.authority.sourceId === reference.sourceId
      && convergence.beforeRecompute.fence.authority.sourceNamespace === reference.sourceNamespace,
    "CURRENT_Q1_NOT_SETTLED");
  } catch { fail("recomputation_invalid"); }
  if (reference?.recomputation?.graphExecution?.state !== "converged") fail("recomputation_not_converged");
  const graphDays = graphWindowDays(), cohort = reference?.provenance?.cohort;
  const owners = [...corpus.owners].sort((left, right) => left.participantId < right.participantId ? -1 : left.participantId > right.participantId ? 1 : 0);
  if (!Array.isArray(cohort) || cohort.length !== 4 || cohort.some((owner) => !exactKeys(owner, ["participantId", "ownerDigest"]))
    || !isDeepStrictEqual(cohort.map((owner) =>
    [owner?.participantId, owner?.ownerDigest]), owners.map((owner) => [owner.participantId, owner.pinnedOwnerDigest]))
    || reference?.recomputation?.liveCohort?.members !== 4) fail("cohort_incomplete");
  const original = reference?.recomputation?.graphForced?.modelDays;
  if (!Array.isArray(original) || !isDeepStrictEqual(original.map((entry) => entry?.day), graphDays)
    || original.some((entry) => !exactKeys(entry, ["day", "recomputedSha256"]) || !SHA256.test(entry.recomputedSha256))
    || !SHA256.test(reference?.recomputation?.graphForced?.previewSha256)) fail("graph_dates_incomplete");
  const publications = reference?.graphPublications;
  if (!Array.isArray(publications) || !Array.isArray(original) || !isDeepStrictEqual(publications.map((entry) => entry?.day), graphDays)
    || publications.some((entry, index) => !exactKeys(entry, ["day", "state", "sha256"]) || entry.state !== "published"
      || !SHA256.test(entry.sha256) || entry.sha256 !== original[index]?.recomputedSha256)) fail("graph_publications_incomplete");
  const missing = Array.isArray(original) ? original.filter((entry) => entry?.recomputedSha256 === null).map((entry) => entry.day) : [];
  const expectedScopeObjects = corpus.owners.flatMap((owner) => [
    ...(reference?.recomputation?.graphForced?.previewSha256 === null ? [{ owner: owner.key, metric: "fits", day: graphDays.at(-1) }] : []),
    ...missing.map((day) => ({ owner: owner.key, metric: "model", day })),
  ]);
  const native = reference?.nativeEvidence;
  try {
    validateCurrentQ1NativeEvidence(native, expectedScopeObjects);
    if (native.some((entry) => !["complete", "not_testable"].includes(entry.state))) fail("native_result_unverified");
  } catch { fail("native_scope_set_incomplete"); }
  try {
    if (!exactKeys(snapshotReadiness, ["afterForcedRecompute", "afterNativeProbes"])
      || !readySnapshotShape(reference.afterForcedRecompute, snapshotReadiness.afterForcedRecompute, corpus, graphDays)
      || !readySnapshotShape(reference.afterNativeProbes, snapshotReadiness.afterNativeProbes, corpus, graphDays)) fail("final_snapshot_incomplete");
  } catch { fail("final_snapshot_incomplete"); }
  requireFact([...reasons].every((reason) => COMPLETENESS_REASONS.includes(reason)), "CURRENT_Q1_INPUT_INVALID");
  return { state: reasons.size === 0 ? "complete" : "unresolved", reasons: [...reasons].sort() };
}

/** A pure, testable qualification gate. Its independent expected values are
 * current authority-fenced D1 reads and current source factories, never PG or
 * historical published output. The operation below supplies those bindings. */
export function assessCurrentQ1ReferenceReadiness({ P, snapshot, corpus, currentDailyRows, previewRow, currentCache }) {
  const reasons = new Set();
  const fail = (code) => { requireFact(READINESS_CODES.includes(code), "CURRENT_Q1_INPUT_INVALID"); reasons.add(code); };
  const nowIso = new Date(CURRENT_Q1_REFERENCE_NOW_MS).toISOString();
  const today = nowIso.slice(0, 10), previewDays = Array.from({ length: 70 }, (_, n) =>
    new Date(Date.parse(today) - (69 - n) * DAY_MS).toISOString().slice(0, 10));
  const publicDays = previewDays.filter((day) => day < today);
  const body = snapshot?.publicResponse?.body, preview = snapshot?.adminPreview;
  if (snapshot?.publicResponse?.status !== 200 || !exactKeys(body, ["schemaVersion", "from", "to", "allowanceState",
    "allowanceReadState", "allowanceBreakdowns", "cacheRetention", "days"])
    || body.schemaVersion !== "community-daily-read-v1.0" || body.from !== corpus.window.fromDay
    || body.to !== corpus.window.throughDay || body.allowanceState !== "ready" || body.allowanceReadState !== "confirmed") {
    fail("public_envelope_invalid");
  }
  const days = Array.isArray(body?.days) ? body.days : [];
  if (!isDeepStrictEqual(days.map((day) => day?.day), corpus.expectedDailyDays)
    || !isDeepStrictEqual(currentDailyRows.map((day) => day.day), corpus.expectedDailyDays)) fail("public_daily_set_incomplete");
  const sample = P.buildCommunityDailyPayload({ day: corpus.window.fromDay, revision: 1, releasedAt: nowIso,
    totals: null, cells: [], cellsTruncated: false, spend: {} });
  const expectedModels = new Set(corpus.owners.flatMap((owner) => owner.models));
  for (const day of days) {
    const payload = day?.payload;
    if (!exactKeys(day, ["day", "revision", "releasedAt", "payload"]) || !count(day.revision) || day.revision < 1
      || day.releasedAt !== nowIso || !exactKeys(payload, Object.keys(sample))
      || payload.schemaVersion !== sample.schemaVersion || payload.policyVersion !== sample.policyVersion
      || payload.suppression !== sample.suppression || payload.day !== day.day || payload.revision !== day.revision
      || payload.releasedAt !== day.releasedAt || payload.aggregateId !== `community-daily:${day.day}:r${day.revision}`
      || payload.immutableRevision !== true || payload.recomputesOnLateData !== true
      || payload.cellsTruncated !== false || !exactKeys(payload.totals, TOTAL_KEYS)
      || TOTAL_KEYS.some((key) => !count(payload.totals[key]))
      || payload.totals.contributingParticipants > corpus.owners.length
      || payload.totals.contributingDevices < payload.totals.contributingParticipants
      || !Array.isArray(payload.cells) || payload.cells.length > expectedModels.size
      || !exactKeys(payload.apiEquivalentSpend, SPEND_KEYS) || !P.isCurrentCommunityDailySpend(payload.apiEquivalentSpend)
      || payload.apiEquivalentSpend.usageEvents !== payload.totals.usageEvents) {
      fail("public_daily_contract_invalid"); continue;
    }
    let previous = "", cellsValid = true;
    for (const cell of payload.cells) {
      const key = `${cell?.provider}\0${cell?.modelId}`;
      if (!exactKeys(cell, CELL_KEYS) || cell.provider !== "openai_codex" || !expectedModels.has(cell.modelId)
        || !["usageEvents", ...TOKEN_KEYS].every((field) => count(cell[field])) || cell.usageEvents < 1 || key <= previous) {
        fail("public_daily_contract_invalid");
        cellsValid = false;
      }
      previous = key;
    }
    for (const field of cellsValid ? ["usageEvents", ...TOKEN_KEYS] : []) {
      const total = payload.cells.reduce((n, cell) => n + cell[field], 0);
      if (!count(total) || total !== payload.totals[field]) fail("public_daily_contract_invalid");
    }
  }
  const expectedDaily = currentDailyRows.map((row) => {
    const payload = JSON.parse(row.payload_json);
    // These are the maintained typed public boundary's only removals. A stale
    // spend or malformed current payload remains invalid, never normalized.
    delete payload.capacityByPlanType; delete payload.allowance;
    return { day: row.day, revision: row.revision, releasedAt: row.released_at, payload };
  });
  if (!isDeepStrictEqual(days, expectedDaily)) fail("public_daily_reference_mismatch");
  if (!object(previewRow) || !object(preview) || previewRow.generated_at !== nowIso || preview.generatedAt !== nowIso
    || !P.validCachedAdminCommunityAllowancePreview(preview, previewRow.generated_at, CURRENT_Q1_REFERENCE_NOW_MS)
    || !isDeepStrictEqual(preview, JSON.parse(previewRow.payload_json))
    || !isDeepStrictEqual(preview.days?.map((day) => day.day), previewDays)
    || !isDeepStrictEqual(preview.models?.days?.map((day) => day.day), previewDays)) {
    fail("current_admin_preview_incomplete");
  }
  if (!isDeepStrictEqual(preview?.models?.modelConfig, P.ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG)
    || !Array.isArray(preview?.models?.days)
    || preview.models.days.some((day) => day.catalogVersion !== P.ADMIN_MODEL_HISTORY_CATALOG_VERSION)) {
    fail("current_admin_catalog_invalid");
  }
  try {
    const projected = P.projectPublicAllowanceGraph(previewRow, { publishedDays: corpus.expectedDailyDays,
      nowMs: CURRENT_Q1_REFERENCE_NOW_MS });
    requireFact(projected !== null, "CURRENT_Q1_INPUT_INVALID");
    const expected = P.wrapPublicAllowanceBreakdownsV15(projected.breakdowns, P.buildCurrentPublicModelMetadata());
    if (!isDeepStrictEqual(body?.allowanceBreakdowns, expected)
      || !isDeepStrictEqual(body.allowanceBreakdowns.days.map((day) => day.day), publicDays)) fail("current_public_projection_invalid");
  } catch { fail("current_public_projection_invalid"); }
  if (currentCache === null || !isDeepStrictEqual(body?.cacheRetention, currentCache)) fail("current_cache_missing_or_mismatched");
  return { state: reasons.size === 0 ? "ready" : "unresolved", reasons: [...reasons].sort(),
    expectedDailyDays: corpus.expectedDailyDays, expectedPreviewDays: previewDays, expectedPublicAllowanceDays: publicDays };
}

async function responseDTO(ctx, corpus) {
  const snapshot = await readCurrentQ1ResponseSnapshot(ctx, corpus.window);
  const window = corpus.window;
  const read = await ctx.P.readPublishedStorageCommunityDaily({ ...bindings(ctx), fromDay: window.fromDay, throughDay: window.throughDay });
  const previewRow = await ctx.P.readPublishedStorageCommunityGraph(bindings(ctx), CURRENT_Q1_REFERENCE_NOW_MS);
  const currentCache = await ctx.P.readCacheRetentionCommunitySeries({ target: ctx.analytics,
    sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID, nowMs: CURRENT_Q1_REFERENCE_NOW_MS });
  return { ...snapshot, readiness: assessCurrentQ1ReferenceReadiness({ P: ctx.P, snapshot, corpus,
    currentDailyRows: read.rows, previewRow, currentCache }) };
}

/** Read only the actual current public/admin DTOs for a supplied closed range.
 * This reusable seam intentionally does not assess or rewrite D1 readiness. */
export async function readCurrentQ1ResponseSnapshot(ctx, window) {
  requireFact(object(window) && exactKeys(window, ["fromDay", "throughDay"])
    && DAY.test(window.fromDay) && DAY.test(window.throughDay) && window.fromDay <= window.throughDay
    && typeof ctx?.P?.handleRequest === "function"
    && typeof ctx.P.readPublishedStorageCommunityAdminPreview === "function",
  "CURRENT_Q1_INPUT_INVALID");
  const allow = { limit: async () => ({ success: true }) };
  const env = { USAGE_MONITOR_DB: ctx.ingestion, ANALYTICS_DB: ctx.analytics, DELETION_LEDGER: ctx.ledger,
    ENVIRONMENT: "synthetic-development", PUBLIC_ANALYTICS_MODE: "enabled", TELEMETRY_STORAGE_MODE: "typed",
    TELEMETRY_STORAGE_NAMESPACE: NAMESPACE, PUBLIC_READ_RATE_LIMIT: allow };
  const response = await ctx.P.handleRequest(new Request(`https://oracle.example.test/api/v1/community/daily?from=${window.fromDay}&to=${window.throughDay}`), env);
  const publicResponse = await response.json();
  const adminPreview = await ctx.P.readPublishedStorageCommunityAdminPreview(bindings(ctx), CURRENT_Q1_REFERENCE_NOW_MS);
  return { publicResponse: { status: response.status, body: publicResponse }, adminPreview };
}

/** Read the current DTOs and existing readiness assessment without rewriting it. */
export async function readCurrentQ1ResponseDTO(ctx, corpus) {
  return responseDTO(ctx, corpus);
}

/** Probe only graph scopes that ordinary current recomputation did not publish.
 * Default production query/deadline limits are retained. A deferred result is
 * never promoted into a completed or native-refused result. */
export async function nativeCheckpointProgress(ctx, scope) {
  const P = ctx.P;
  let method, dependencyDigest;
  if (scope.source === "v1.1") {
    method = P.storageGraphV11CheckpointMethod(scope.metric, false);
    dependencyDigest = scope.checkpointDependencyDigest;
  } else if (scope.source === "effective") {
    method = scope.metric === "fits" ? P.STORAGE_GRAPH_EFFECTIVE_FITS_CHECKPOINT_METHOD
      : P.STORAGE_GRAPH_EFFECTIVE_MODEL_CHECKPOINT_METHOD;
    dependencyDigest = scope.checkpointDependencyDigest;
  } else if (scope.source === "v1" && scope.metric === "fits") {
    method = P.STORAGE_GRAPH_CURRENT_FIT_CHECKPOINT_METHOD;
    dependencyDigest = scope.dependencyDigest;
  } else if (["v1", "mixed"].includes(scope.source) && scope.metric === "model") {
    method = P.STORAGE_GRAPH_HISTORY_CHECKPOINT_METHOD;
    dependencyDigest = scope.dependencyDigest;
  }
  if (method === undefined) return jsonSha({ keyDigest: null });
  requireFact(P.STORAGE_GRAPH_LIVE_CHECKPOINT_METHODS.includes(method), "CURRENT_Q1_INPUT_INVALID");
  const keyDigest = await P.storageHistoryKeyDigest({ sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID,
    sourceNamespace: NAMESPACE, ownerDigest: scope.owner.ownerDigest, day: scope.day, dependencyDigest, method });
  const [heads, stages, parts] = await ctx.analytics.batch([
    ctx.analytics.prepare(`SELECT generation,retired FROM analytics_history_checkpoint_heads WHERE key_digest=?`)
      .bind(keyDigest),
    ctx.analytics.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(part_count),0) AS parts,
      COALESCE(SUM(length(control_json)),0) AS controlBytes,COALESCE(SUM(length(manifest_json)),0) AS manifestBytes
      FROM analytics_history_checkpoint_stages WHERE key_digest=?`).bind(keyDigest),
    ctx.analytics.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(payload_bytes),0) AS bytes
      FROM analytics_history_checkpoint_parts WHERE key_digest=?`).bind(keyDigest),
  ]);
  // The per-key aggregates include all stage generations, including unpromoted
  // successors, while keeping checkpoint contents out of the observer.
  return jsonSha({ keyDigest, heads: heads.results, stages: stages.results, parts: parts.results });
}

export async function probeCurrentQ1MissingScopes(ctx, corpus, recomputation) {
  const owners = await ctx.P.readStorageCommunityOwnerPage(ctx.ingestion, { limit: 5 });
  requireFact(owners.length === 4, "CURRENT_Q1_ADMISSION_FAILED");
  const ownerKey = new Map(corpus.owners.map((owner) => [owner.pinnedOwnerDigest, owner.key]));
  const evidence = [];
  const dates = recomputation.graphForced.modelDays.filter((entry) => entry.recomputedSha256 === null).map((entry) => entry.day);
  const scopes = owners.flatMap((owner) => [...(recomputation.graphForced.previewSha256 === null ? [{ owner, metric: "fits",
    day: "2026-10-01" }] : []), ...dates.map((day) => ({ owner, metric: "model", day }))]);
  for (const [scopeIndex, { owner, metric, day }] of scopes.entries()) {
    const item = { owner: ownerKey.get(owner.ownerDigest), metric, day, state: "unresolved", invocations: 0 };
    requireFact(["a", "b", "c", "d"].includes(item.owner), "CURRENT_Q1_ADMISSION_FAILED");
    try {
      ctx.progress.counts({ scopeOrdinal: scopeIndex + 1, iteration: 0 });
      const scope = await ctx.P.captureStorageGraphScope(ctx.ingestion, { owner, metric, day,
        sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID, sourceNamespace: NAMESPACE, preparedFold: false });
      let previous = await nativeCheckpointProgress(ctx, scope), stall = 0;
      for (let n = 0; n < BOUNDS.nativeInvocations; n++) {
        ctx.progress.counts({ scopeOrdinal: scopeIndex + 1, iteration: n + 1 });
        const outcome = await ctx.P.computeStorageGraphResult(bindings(ctx), scope,
          { preparedFold: false, now: () => CURRENT_Q1_REFERENCE_NOW_MS });
        item.invocations++;
        if (outcome.state === "complete") {
          // Re-read through the production method/dependency, SHA, source and
          // authority fence. A compute outcome alone is never acceptance proof.
          const verified = await ctx.P.readStorageGraphResult(bindings(ctx), scope);
          delete item.reason;
          Object.assign(item, classifyCurrentQ1VerifiedNativeOutcome({ metric, outcome, verified,
            knownNotTestableReasons: ctx.P.COMMUNITY_MODEL_REFUSAL_REASONS }));
          break;
        }
        item.state = "unresolved";
        item.reason = outcome.failure?.reason && ctx.P.STORAGE_GRAPH_FAILURE_REASONS.includes(outcome.failure.reason)
          ? outcome.failure.reason : "deferred";
        const next = await nativeCheckpointProgress(ctx, scope); stall = next === previous ? stall + 1 : 0; previous = next;
        if (stall >= BOUNDS.nativeStall) { item.bound = "stall"; break; }
        if (n + 1 === BOUNDS.nativeInvocations) item.bound = "invocations";
      }
    } catch (error) {
      // Only an actual typed production failure is proved; never classify a
      // missing value or an arbitrary exception as a native capacity refusal.
      if (error instanceof ctx.P.StorageGraphOperationError) {
        item.state = "refused";
        item.nativeCapacityRefusal = false;
        item.reason = ctx.P.STORAGE_GRAPH_FAILURE_REASONS.includes(error.reason) ? error.reason : "application";
        item.phase = ctx.P.STORAGE_GRAPH_OPERATION_STAGES.includes(error.stage) ? error.stage : "graph_scope";
      } else { item.state = "unresolved"; item.reason = "execution_failed"; }
    }
    evidence.push(item);
  }
  return evidence;
}

/** All output is in memory unless the caller explicitly supplies a new --out.
 * Every scratch database is fresh; finally removes only this process's owned
 * directory after rechecking its filesystem identity. */
export async function runCurrentQ1D1Reference() {
  requireFact(!held, "CURRENT_Q1_BUSY"); held = true;
  let root, identity, vite, restore;
  const progress = createS9Progress("producer");
  let phase = "source_provenance";
  const enter = (value) => { phase = value; progress.phase(value); };
  let admissionTrace;
  const handles = [];
  try {
    enter("source_provenance");
    const expected = await captureCurrentQ1ReferenceBinding(), { runtime, source } = expected;
    enter("runtime");
    const { DatabaseSync } = await import("node:sqlite");
    const { createServer } = await import("vite");
    const { openSealedSqliteD1 } = await import("../../cloud-run/sealed-sqlite-d1-adapter.mjs");
    restore = pinRuntime(DatabaseSync);
    root = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-current-q1-d1-")));
    await chmod(root, 0o700); identity = await lstat(root);
    requireFact(identity.isDirectory() && !identity.isSymbolicLink() && identity.uid === process.getuid()
      && (identity.mode & 0o077) === 0, "CURRENT_Q1_SCRATCH_INVALID");
    enter("module_load");
    vite = await createServer({ root: WORKER_ROOT, configFile: false, appType: "custom", logLevel: "silent",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    const P = await loadCurrent(vite);
    enter("corpus_validation");
    const corpus = await corpusInput(P), migrations = [];
    const admissionIdentities = await buildCurrentQ1AdmissionIdentities(P, corpus);
    requireFact(isDeepStrictEqual(capturedCorpusStructure(corpus, admissionIdentities), expected.corpusStructure),
      "CURRENT_Q1_CORPUS_INVALID");
    admissionTrace = admissionDiagnostic(P);
    const ctx = { P, progress, admissionDiagnostic: admissionTrace, objects: inertObjectStore(),
      sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID, sourceNamespace: NAMESPACE, nowMs: CURRENT_Q1_REFERENCE_NOW_MS };
    const paths = {};
    for (const role of ["ingestion", "analytics", "ledger"]) {
      paths[role] = join(root, `${role}.sqlite`);
      const handle = openSealedSqliteD1(paths[role], { create: true, pinnedNowMs: CURRENT_Q1_REFERENCE_NOW_MS });
      handles.push(handle); ctx[role] = handle.database; await chmod(paths[role], 0o600);
    }
    enter("migrations");
    for (const directory of INGESTION_MIGRATIONS.slice(0, 4)) await applyMigrations(ctx.ingestion, directory, migrations);
    await applyMigrations(ctx.analytics, "analytics-migrations", migrations);
    await applyMigrations(ctx.ledger, "deletion-ledger-migrations", migrations);
    await P.initializeStorageSource(ctx.ingestion, CURRENT_Q1_REFERENCE_SOURCE_ID);
    await applyMigrations(ctx.ingestion, INGESTION_MIGRATIONS[4], migrations);
    await P.initializeTypedV11Admission(ctx.ingestion, NAMESPACE);
    await P.initializeTypedV1Admission(ctx.ingestion, NAMESPACE);
    await applyMigrations(ctx.ingestion, INGESTION_MIGRATIONS[5], migrations);
    await P.initializeStorageAnalyticsRuntime(bindings(ctx));
    await ctx.ingestion.prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    await ctx.ingestion.prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date().toISOString()).run();
    await ctx.ingestion.prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const runtimeContracts = await ctx.ingestion.prepare(`SELECT a.runtime_contract_version AS v1,b.runtime_contract_version AS v11
      FROM typed_v1_admission_state a JOIN typed_v11_admission_state b ON b.id=a.id WHERE a.id=1`).first();
    requireFact(runtimeContracts?.v1 === 1 && runtimeContracts?.v11 === 1, "CURRENT_Q1_ADMISSION_FAILED");
    enter("admission");
    const admissions = await seedCorpus(ctx, corpus.owners);
    enter("settle"); const beforeDailyPasses = await settle(ctx, corpus);
    ctx.expectedSource = ctx.initialSource;
    assertCurrentQ1SourceUnchanged(ctx.initialSource, await captureCurrentQ1SourceInvariant(ctx.ingestion));
    const cohortRows = await P.readStorageCommunityOwnerPage(ctx.ingestion, { limit: 5 });
    requireFact(cohortRows.length === 4 && cohortRows.every((owner) => corpus.owners.some((expected) =>
      expected.participantId === owner.participantId && expected.pinnedOwnerDigest === owner.ownerDigest)), "CURRENT_Q1_ADMISSION_FAILED");
    const cohort = cohortRows.map(({ participantId, ownerDigest }) => ({ participantId, ownerDigest }))
      .sort((left, right) => left.participantId < right.participantId ? -1 : left.participantId > right.participantId ? 1 : 0);
    enter("public_before");
    const beforeForcedRecompute = await responseDTO(ctx, corpus);
    const beforeConvergence = await convergenceSnapshot(ctx, corpus, beforeDailyPasses, admissions);
    enter("oracle");
    const strictExportRefusal = await proveCurrentQ1StrictExportRefusal(ctx, source.sha256);
    assertCurrentQ1SourceUnchanged(ctx.expectedSource, await captureCurrentQ1SourceInvariant(ctx.ingestion));
    ctx.sourceInvariant = async () => {
      const current = await captureCurrentQ1SourceInvariant(ctx.ingestion);
      assertCurrentQ1SourceUnchanged(ctx.expectedSource, current); return current.sha256;
    };
    ctx.assertControlTransition = async (controlsBefore, controlsAfter) => {
      const afterControl = await captureCurrentQ1SourceInvariant(ctx.ingestion);
      const transition = assertCurrentQ1ControlTransition({ before: ctx.expectedSource, after: afterControl,
        controlsBefore, controlsAfter, nowMs: ctx.nowMs,
        actorDigest: await P.sha256Hex("app-usagemonitor/admin-actor/v1\0current-q1-reference-scratch") });
      ctx.expectedSource = afterControl; return transition;
    };
    const { recomputation, dailyPasses: afterDailyPasses } = await runCurrentQ1Recomputation(ctx, corpus, ctx.initialSource.sha256);
    const afterConvergence = await convergenceSnapshot(ctx, corpus, afterDailyPasses, admissions);
    const corpusConvergence = validateCurrentQ1CorpusConvergence({ schemaVersion: "current-q1-d1-corpus-convergence-v1",
      beforeRecompute: beforeConvergence, afterRecompute: afterConvergence }, corpus);
    enter("public_after");
    const afterForcedRecompute = await responseDTO(ctx, corpus);
    enter("native_probes");
    const nativeEvidence = await probeCurrentQ1MissingScopes(ctx, corpus, recomputation);
    const afterNativeProbes = await responseDTO(ctx, corpus);
    enter("source_recheck");
    await ctx.sourceInvariant();
    requireFact(isDeepStrictEqual(ctx.initialConflict, await conflictEvidence(ctx, corpus)), "CURRENT_Q1_NOT_SETTLED");
    const finalQueue = (await ctx.analytics.prepare("SELECT source_id,day,revision FROM analytics_community_daily_queue ORDER BY source_id,day").all()).results;
    requireFact(finalQueue.every((row) => row.source_id === ctx.sourceId)
      && isDeepStrictEqual(finalQueue.map(({ day, revision }) => ({ day, revision })), afterConvergence.retainedQueue), "CURRENT_Q1_NOT_SETTLED");
    const after = await sourceSnapshot();
    requireFact(after.head === source.head && after.sha256 === source.sha256, "CURRENT_Q1_SOURCE_CHANGED");
    for (const migration of migrations) requireFact(sha(await boundedFile(join(REPOSITORY_ROOT, migration.path))) === migration.sha256,
      "CURRENT_Q1_SOURCE_CHANGED");
    const reference = { schemaVersion: "current-q1-d1-reference-v2", synthetic: true, qualification: "unresolved",
      sourceId: CURRENT_Q1_REFERENCE_SOURCE_ID, sourceNamespace: NAMESPACE, bounds: BOUNDS,
      provenance: { source, runtime, corpus: corpus.provenance, migrations, migrationSha256: jsonSha(migrations), runtimeContracts,
        admissions, admissionSha256: jsonSha(admissions), cohort },
      beforeForcedRecompute, afterForcedRecompute, afterNativeProbes, recomputation, corpusConvergence, strictExportRefusal,
      graphPublications: recomputation.graphForced.modelDays.map((entry) => ({ day: entry.day,
        state: entry.recomputedSha256 === null ? "not_published" : "published", sha256: entry.recomputedSha256 })), nativeEvidence };
    validateCurrentQ1ReferenceBinding({ reference, expected });
    reference.qualification = assessCurrentQ1ReferenceCompleteness({ reference, corpus: expected.corpusStructure,
      snapshotReadiness: { afterForcedRecompute: afterForcedRecompute.readiness, afterNativeProbes: afterNativeProbes.readiness } }).state;
    return reference;
  } catch (error) {
    const code = ERRORS.includes(error?.code) ? error.code
      : ORACLE_CODES.has(error?.code) ? "CURRENT_Q1_ORACLE_FAILED" : "CURRENT_Q1_EXECUTION_FAILED";
    const closed = Object.assign(new Error(code), { code });
    Object.defineProperty(closed, "diagnostic", { value: Object.freeze({ phase,
      ...(phase === "admission" ? { admission: admissionTrace.snapshot(error) } : {}),
      ...(ORACLE_CODES.has(error?.code) ? { oracleCode: error.code,
        reasons: Object.freeze(Array.isArray(error.reasons) ? error.reasons.filter((reason) => QUIESCENCE_REASONS.has(reason)) : []) } : {}) }),
    enumerable: false, writable: false, configurable: false });
    throw closed;
  } finally {
    enter("cleanup");
    let cleanupFailed = false;
    try {
      for (const handle of handles.reverse()) {
        try { handle.close(); } catch { cleanupFailed = true; }
      }
      try { await vite?.close(); } catch { cleanupFailed = true; }
    } finally {
      try {
        if (root && identity && !cleanupFailed) {
          const current = await lstat(root);
          requireFact(current.isDirectory() && !current.isSymbolicLink() && current.uid === identity.uid
            && current.dev === identity.dev && current.ino === identity.ino && await realpath(root) === root,
          "CURRENT_Q1_CLEANUP_FAILED");
          await rm(root, { recursive: true });
        }
      } finally { restore?.(); held = false; progress.close(); }
    }
    requireFact(!cleanupFailed, "CURRENT_Q1_CLEANUP_FAILED");
  }
}

export async function runCurrentQ1D1ReferenceCli(argv = process.argv.slice(2)) {
  try {
    requireFact(argv.length === 2 && argv[0] === "--out" && isAbsolute(argv[1]), "CURRENT_Q1_OUTPUT_INVALID");
    const output = resolve(argv[1]), parent = dirname(output), metadata = await lstat(parent);
    requireFact(metadata.isDirectory() && !metadata.isSymbolicLink() && await realpath(parent) === parent
      && metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0, "CURRENT_Q1_OUTPUT_INVALID");
    // Reject an existing destination before the expensive run, and use wx again
    // after it to close the race. Never replace an old reference or golden.
    let present = false;
    try { await lstat(output); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    requireFact(!present, "CURRENT_Q1_OUTPUT_INVALID");
    const result = await runCurrentQ1D1Reference();
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ event: "current_q1_d1_reference", qualification: result.qualification,
      sourceHead: result.provenance.source.head, sha256: jsonSha(result) }));
    return result.qualification === "complete" ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "current_q1_d1_reference", qualification: "failed",
      code: ERRORS.includes(error?.code) ? error.code : "CURRENT_Q1_EXECUTION_FAILED",
      ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCurrentQ1D1ReferenceCli();
}
