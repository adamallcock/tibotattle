import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  realpath,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadVerifiedLocalMetadataBundleFiles,
} from "./bundle-verifier.js";
import {
  prepareLatestHourLocalContribution,
} from "./local-contribution-preparation.js";
import {
  TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
} from "./telemetry-contribution-builder.js";
import {
  loadVerifiedPreparedContribution,
  verifyPreparedContributionSet,
} from "./telemetry-prepared-set.js";
import {
  stableJson,
  writeOwnerOnlyNoClobberDurable,
} from "./storage.js";

export const REAL_LOCAL_BACKEND_ACCEPTANCE_RECEIPT_VERSION =
  "real-local-backend-acceptance-receipt-v0.1";
export const REAL_LOCAL_BACKEND_ACCEPTANCE_CONFIRMATION =
  "ACCEPT_REAL_LOCAL_CODEX_EXPORT";
export const REAL_LOCAL_BACKEND_ACCEPTANCE_MAXIMUM_PERIOD_MS =
  60 * 60 * 1_000;

const rootDirectory = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const labScript = join(
  rootDirectory,
  "apps",
  "worker",
  "scripts",
  "start-local-backend-lab.mjs",
);
const OPTION_NAMES = new Set([
  "--confirm",
  "--start-at",
  "--end-at",
  "--codex-home",
  "--identity-file",
  "--work-directory",
  "--receipt-file",
  "--cleanup",
  "--activity-file",
  "--port",
]);

export class RealLocalBackendAcceptanceError extends Error {
  constructor(code) {
    super("Real local backend acceptance failed");
    this.name = "RealLocalBackendAcceptanceError";
    this.code = code;
  }
}

function fail(code) {
  throw new RealLocalBackendAcceptanceError(code);
}

function exactInstant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return normalized === value ? normalized : null;
}

function exactAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 1
    && value.length <= 4_096
    && isAbsolute(value)
    ? resolve(value)
    : null;
}

function boundedPort(value) {
  if (!/^[0-9]+$/u.test(value ?? "")) fail("arguments_invalid");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    fail("arguments_invalid");
  }
  return port;
}

function within(path, parent) {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

export function parseRealLocalBackendAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    fail("arguments_invalid");
  }
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!OPTION_NAMES.has(option) || Object.hasOwn(values, option)) {
      fail("arguments_invalid");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail("arguments_invalid");
    values[option] = value;
    index += 1;
  }
  const required = [
    "--confirm",
    "--start-at",
    "--end-at",
    "--codex-home",
    "--identity-file",
    "--work-directory",
    "--receipt-file",
    "--cleanup",
  ];
  if (required.some((name) => !Object.hasOwn(values, name))) {
    fail("arguments_invalid");
  }
  if (values["--confirm"] !== REAL_LOCAL_BACKEND_ACCEPTANCE_CONFIRMATION) {
    fail("confirmation_required");
  }
  if (values["--cleanup"] !== "recoverable-trash") {
    fail("recoverable_cleanup_required");
  }
  const startAt = exactInstant(values["--start-at"]);
  const endAt = exactInstant(values["--end-at"]);
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (startAt === null
      || endAt === null
      || end <= start
      || end - start > REAL_LOCAL_BACKEND_ACCEPTANCE_MAXIMUM_PERIOD_MS) {
    fail("bounded_period_required");
  }
  const codexHome = exactAbsolutePath(values["--codex-home"]);
  const identityFile = exactAbsolutePath(values["--identity-file"]);
  const workDirectory = exactAbsolutePath(values["--work-directory"]);
  const receiptFile = exactAbsolutePath(values["--receipt-file"]);
  const activityFile = values["--activity-file"]
    ? exactAbsolutePath(values["--activity-file"])
    : join(workDirectory ?? "/", "activity-markers-absent.jsonl");
  if (!codexHome
      || !identityFile
      || !workDirectory
      || !receiptFile
      || !activityFile
      || within(receiptFile, workDirectory)) {
    fail("arguments_invalid");
  }
  return Object.freeze({
    confirmation: REAL_LOCAL_BACKEND_ACCEPTANCE_CONFIRMATION,
    startAt,
    endAt,
    codexHome,
    identityFile,
    workDirectory,
    receiptFile,
    activityFile,
    cleanup: "recoverable-trash",
    port: values["--port"] ? boundedPort(values["--port"]) : 8793,
  });
}

function countRecords(recordCounts) {
  const values = [
    recordCounts?.usageEvents,
    recordCounts?.quotaSnapshots,
    recordCounts?.activityMarkers,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("prepared_set_invalid");
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) fail("prepared_set_invalid");
  return total;
}

function assertOwnerOnlyDirectory(stats) {
  if (!stats.isDirectory()
      || stats.isSymbolicLink()
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || (process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
    fail("workspace_invalid");
  }
}

async function createOwnerOnlyWorkspace(path) {
  try {
    await mkdir(path, { mode: 0o700 });
    const stats = await lstat(path);
    assertOwnerOnlyDirectory(stats);
    const canonical = await realpath(path);
    const canonicalStats = await lstat(canonical);
    assertOwnerOnlyDirectory(canonicalStats);
    if (stats.dev !== canonicalStats.dev || stats.ino !== canonicalStats.ino) {
      fail("workspace_invalid");
    }
    return canonical;
  } catch (error) {
    if (error instanceof RealLocalBackendAcceptanceError) throw error;
    fail("workspace_invalid");
  }
}

async function preflightReceiptDestination(path) {
  try {
    const parent = dirname(path);
    const parentStats = await lstat(parent);
    assertOwnerOnlyDirectory(parentStats);
    const canonicalParent = await realpath(parent);
    const canonicalStats = await lstat(canonicalParent);
    assertOwnerOnlyDirectory(canonicalStats);
    if (parentStats.dev !== canonicalStats.dev
        || parentStats.ino !== canonicalStats.ino) {
      fail("receipt_destination_invalid");
    }
    try {
      await lstat(path);
      fail("receipt_destination_invalid");
    } catch (error) {
      if (error instanceof RealLocalBackendAcceptanceError) throw error;
      if (error?.code !== "ENOENT") fail("receipt_destination_invalid");
    }
  } catch (error) {
    if (error instanceof RealLocalBackendAcceptanceError) throw error;
    fail("receipt_destination_invalid");
  }
}

function defaultRunBackendLab({
  contributionFile,
  stateDirectory,
  port,
}) {
  const run = spawnSync(process.execPath, [
    labScript,
    "--exit-after-receipt",
    "--state-directory",
    stateDirectory,
    "--port",
    String(port),
    "--file",
    contributionFile,
  ], {
    cwd: rootDirectory,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) fail("backend_lab_failed");
  try {
    return JSON.parse(readFileSync(
      join(stateDirectory, "lab-receipt.json"),
      "utf8",
    ));
  } catch {
    fail("backend_lab_failed");
  }
}

async function defaultMoveWorkspaceToTrash(path, {
  uuid = randomUUID,
  trashDirectory = join(homedir(), ".Trash"),
} = {}) {
  try {
    const trash = await realpath(trashDirectory);
    assertOwnerOnlyDirectory(await lstat(trash));
    await rename(
      path,
      join(trash, `app-usagemonitor-real-backend-acceptance-${uuid()}`),
    );
  } catch (error) {
    if (error instanceof RealLocalBackendAcceptanceError) throw error;
    fail("recoverable_cleanup_failed");
  }
}

function projectBackendEvidence(labReceipt, expectedRecordCount) {
  const smoke = labReceipt?.smoke;
  const lifecycle = labReceipt?.destructiveLifecycle;
  const d1 = lifecycle?.d1;
  const restart = labReceipt?.persistedRestart;
  const acceptance = labReceipt?.acceptance;
  if (labReceipt?.schemaVersion !== "local-backend-lab-receipt-v0.3"
      || labReceipt?.status !== "ready"
      || labReceipt?.source?.mode !== "prepared_contribution"
      || labReceipt.source.containsRawLogs !== false
      || smoke?.participants !== 20
      || smoke?.acceptedRecordsPerParticipant !== expectedRecordCount
      || smoke?.idempotentReplay !== true
      || smoke?.privacyCanaryRejected !== true
      || smoke?.canonicalServerRepricing !== true
      || smoke?.aggregatePublishedAtTwenty !== true
      || smoke?.participantExportVerified !== true
      || acceptance?.individualContributionDeletionVerified !== true
      || acceptance?.fullParticipantDeletionVerified !== true
      || acceptance?.persistedRestartVerified !== true
      || d1?.activeParticipants !== 0
      || d1?.acceptedContributions !== 0
      || d1?.canonicalRecords !== 0
      || d1?.retainedQuarantineReferences !== 0
      || lifecycle?.directLocalR2ObjectCount !== 0
      || restart?.workerRestartedAgainstSameStateDirectory !== true
      || restart?.privateStatsRestored !== true) {
    fail("backend_lab_receipt_invalid");
  }
  return Object.freeze({
    labReceiptSchemaVersion: labReceipt.schemaVersion,
    sourceMode: "prepared_contribution",
    participants: 20,
    acceptedRecordsPerParticipant: expectedRecordCount,
    checks: Object.freeze({
      idempotentReplay: true,
      privacyCanaryRejected: true,
      canonicalServerRepricing: true,
      personalStatisticsRecomputed:
        smoke.personalStatisticsRecomputed === true,
      aggregatePublishedAtTwenty: true,
      authenticatedWeeklyComparison:
        smoke.authenticatedWeeklyComparison === true,
      participantExportVerified: true,
      individualContributionDeletion:
        acceptance.individualContributionDeletionVerified === true,
      fullParticipantDeletion: true,
      persistedRestart: true,
    }),
    destructiveFinalStorage: Object.freeze({
      activeParticipants: 0,
      acceptedContributions: 0,
      canonicalRecords: 0,
      retainedQuarantineReferences: 0,
      liveR2Objects: 0,
      deletionTombstones: lifecycle?.deletionLedger?.tombstones ?? null,
      withdrawnSnapshots: d1?.withdrawnSnapshots ?? null,
      suppressedSnapshots: d1?.suppressedSnapshots ?? null,
    }),
  });
}

function assertContentFreeReceipt(receipt, forbiddenValues) {
  const serialized = stableJson(receipt);
  const forbiddenKeys = [
    "\"stateDirectory\"",
    "\"participantAccessFile\"",
    "\"receiptFile\"",
    "\"contributionFile\"",
    "\"codexHome\"",
    "\"identityFile\"",
    "\"participantId\"",
    "\"accountScopeId\"",
    "\"sessionScopeId\"",
    "\"recoveryCode\"",
    "\"csrfToken\"",
  ];
  if (forbiddenKeys.some((key) => serialized.includes(key))
      || forbiddenValues.some((value) => serialized.includes(value))) {
    fail("receipt_privacy_boundary");
  }
  return serialized;
}

export async function runRealLocalBackendAcceptance(options, {
  prepareContribution = prepareLatestHourLocalContribution,
  verifySource = loadVerifiedLocalMetadataBundleFiles,
  verifyPreparedSet = verifyPreparedContributionSet,
  loadPreparedContribution = loadVerifiedPreparedContribution,
  runBackendLab = defaultRunBackendLab,
  moveWorkspaceToTrash = defaultMoveWorkspaceToTrash,
  writeReceipt = writeOwnerOnlyNoClobberDurable,
  uuid = randomUUID,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!options || typeof options !== "object"
      || typeof prepareContribution !== "function"
      || typeof verifySource !== "function"
      || typeof verifyPreparedSet !== "function"
      || typeof loadPreparedContribution !== "function"
      || typeof runBackendLab !== "function"
      || typeof moveWorkspaceToTrash !== "function"
      || typeof writeReceipt !== "function"
      || typeof uuid !== "function"
      || typeof clock !== "function") {
    fail("arguments_invalid");
  }
  const canonicalOptions = parseRealLocalBackendAcceptanceArguments([
    "--confirm",
    options.confirmation,
    "--start-at",
    options.startAt,
    "--end-at",
    options.endAt,
    "--codex-home",
    options.codexHome,
    "--identity-file",
    options.identityFile,
    "--work-directory",
    options.workDirectory,
    "--receipt-file",
    options.receiptFile,
    "--cleanup",
    options.cleanup,
    "--activity-file",
    options.activityFile,
    "--port",
    String(options.port),
  ]);
  await preflightReceiptDestination(canonicalOptions.receiptFile);
  const work = await createOwnerOnlyWorkspace(canonicalOptions.workDirectory);
  const preparationId = uuid();
  const reviewRoot = join(work, "reviews");
  const preparedRoot = join(work, "prepared");
  const backendLabDirectory = join(work, "backend-lab");
  try {
    await prepareContribution({
      coveredAt: {
        startAt: canonicalOptions.startAt,
        endAt: canonicalOptions.endAt,
      },
      codexHome: canonicalOptions.codexHome,
      activityFile: canonicalOptions.activityFile,
      reviewArchiveDirectory: reviewRoot,
      preparedSpoolDirectory: preparedRoot,
      explicitSecretFile: canonicalOptions.identityFile,
      uuid: () => preparationId,
    });
  } catch {
    fail("local_preparation_failed");
  }
  const reviewDirectory = join(reviewRoot, `review-${preparationId}`);
  const bundleFile = join(reviewDirectory, "review.umx.json");
  const sourceReceiptFile = join(
    reviewDirectory,
    "review.umx.json.privacy-receipt.json",
  );
  const preparedDirectory = join(
    preparedRoot,
    `prepared-set-${preparationId}`,
  );
  let verifiedSource;
  let manifest;
  let contribution;
  try {
    verifiedSource = await verifySource({
      bundleFile,
      receiptFile: sourceReceiptFile,
    });
    manifest = await verifyPreparedSet({
      directory: preparedDirectory,
      builderVersion: TELEMETRY_CONTRIBUTION_BUILDER_VERSION,
    });
    const selected = manifest.files[0];
    contribution = await loadPreparedContribution({
      directory: preparedDirectory,
      entry: selected,
    });
  } catch {
    fail("prepared_set_invalid");
  }
  const selected = manifest.files[0];
  const expectedRecordCount = countRecords(selected.recordCounts);
  const sha256 = /^[a-f0-9]{64}$/u;
  if (manifest.batchCount < 1
      || manifest.files.length !== manifest.batchCount
      || verifiedSource?.summary?.verdict !== "passed"
      || verifiedSource?.summary?.transportReady !== false
      || !sha256.test(verifiedSource?.bundleSha256 ?? "")
      || !sha256.test(verifiedSource?.receiptSha256 ?? "")
      || !Number.isSafeInteger(verifiedSource?.summary?.bundleBytes)
      || verifiedSource.summary.bundleBytes < 1
      || contribution?.coveredAt?.startAt !== canonicalOptions.startAt
      || contribution?.coveredAt?.endAt !== canonicalOptions.endAt
      || expectedRecordCount < 1) {
    fail("prepared_set_invalid");
  }
  const contributionFile = join(preparedDirectory, selected.basename);
  let labReceipt;
  try {
    labReceipt = await runBackendLab({
      contributionFile,
      stateDirectory: backendLabDirectory,
      port: canonicalOptions.port,
    });
  } catch (error) {
    if (error instanceof RealLocalBackendAcceptanceError) throw error;
    fail("backend_lab_failed");
  }
  const backend = projectBackendEvidence(labReceipt, expectedRecordCount);
  const manifestJson = stableJson(manifest);
  const createdAt = exactInstant(clock());
  if (createdAt === null) fail("receipt_invalid");
  const receipt = Object.freeze({
    schemaVersion: REAL_LOCAL_BACKEND_ACCEPTANCE_RECEIPT_VERSION,
    status: "passed",
    createdAt,
    source: Object.freeze({
      provider: "openai_codex",
      coveredAt: Object.freeze({
        startAt: canonicalOptions.startAt,
        endAt: canonicalOptions.endAt,
      }),
      privacyVerdict: verifiedSource?.summary?.verdict,
      transportReady: verifiedSource?.summary?.transportReady,
      bundleSha256: verifiedSource?.bundleSha256,
      privacyReceiptSha256: verifiedSource?.receiptSha256,
      bundleBytes: verifiedSource?.summary?.bundleBytes,
      recordCounts: Object.freeze({
        ...verifiedSource?.summary?.recordCounts,
      }),
    }),
    preparedSet: Object.freeze({
      schemaVersion: manifest.schemaVersion,
      builderVersion: manifest.builderVersion,
      manifestSha256:
        createHash("sha256").update(manifestJson).digest("hex"),
      manifestBytes: Buffer.byteLength(manifestJson, "utf8"),
      batchCount: manifest.batchCount,
      selectedMember: Object.freeze({
        ordinal: 1,
        sha256: selected.sha256,
        bytes: selected.bytes,
        recordCounts: Object.freeze({ ...selected.recordCounts }),
      }),
    }),
    backend,
    cleanup: Object.freeze({
      policy: "explicit_recoverable_trash",
      workspaceDisposition: "moved_to_trash",
      recoverable: true,
      retainedArtifacts: Object.freeze([
        "content_free_acceptance_receipt",
      ]),
    }),
    privacy: Object.freeze({
      containsRawLogs: false,
      containsPaths: false,
      containsCredentials: false,
      containsAccountIdentifiers: false,
      containsParticipantIdentifiers: false,
      externalNetworkActivity: false,
      loopbackBackendTrafficOnly: true,
    }),
  });
  const serialized = assertContentFreeReceipt(receipt, [
    canonicalOptions.codexHome,
    canonicalOptions.identityFile,
    canonicalOptions.workDirectory,
    canonicalOptions.receiptFile,
    preparationId,
  ]);
  try {
    await moveWorkspaceToTrash(work);
  } catch (error) {
    if (error instanceof RealLocalBackendAcceptanceError) throw error;
    fail("recoverable_cleanup_failed");
  }
  try {
    await writeReceipt(
      canonicalOptions.receiptFile,
      `${serialized}\n`,
      { maximumBytes: 256 * 1024 },
    );
  } catch {
    fail("receipt_publication_failed");
  }
  return receipt;
}
